// Session registry rehydration — survives Railway restarts / tsx-watch reloads.
//
// The in-memory `sessionRegistry` (registry.ts) is lost on every server
// restart. Without rehydration, every route that reads it has to 404 for any
// live session created before the restart, even though the Supabase
// `sessions` row + the E2B sandbox are both still alive.
//
// `getOrRehydrateSession` is the registry accessor for all routes that
// previously called `sessionRegistry.get(sessionId)` directly. On miss it
// reads the row from Supabase, reconnects to the E2B sandbox, re-mints a
// fresh LiteLLM key with the remaining budget, re-arms the expiry timer,
// and rebuilds the in-memory entry. On any unrecoverable failure (sandbox
// reaped, budget exhausted, deadline already passed) it marks the row
// terminal and returns null so the caller can produce a clean 4xx instead
// of a hang.
//
// The single in-flight guard (rehydratingNow) prevents two concurrent
// requests on the same session from each doing the (expensive) reconnect.

import { Sandbox } from "e2b";
import { env } from "../env.js";
import { sessionRegistry, type SessionEntry, type PersonaState } from "./registry.js";
import {
  loadSessionRowFull,
  loadNextEventSeq,
  loadNextTranscriptSeq,
  persistSessionUpdate,
} from "./db.js";
import { mintSessionKey } from "./litellm.js";
import { loadScenarioById } from "./scenarios.js";
import { expireSession } from "./session.js";
import { appendEvent } from "./events-direct.js";

const DEFAULT_PERSONA_STATE: PersonaState = {
  client: { revealed_specifics: false, requirement_changed: false },
  team:   { gave_refund_hint: false, gave_webhook_clue: false },
};

// In-flight rehydrate promises keyed by sessionId — prevents concurrent
// requests on the same session from triggering parallel reconnect attempts.
const rehydratingNow = new Map<string, Promise<SessionEntry | null>>();

export async function getOrRehydrateSession(
  sessionId: string,
): Promise<SessionEntry | null> {
  const cached = sessionRegistry.get(sessionId);
  if (cached) return cached;

  const inflight = rehydratingNow.get(sessionId);
  if (inflight) return inflight;

  const p = rehydrate(sessionId).finally(() => {
    rehydratingNow.delete(sessionId);
  });
  rehydratingNow.set(sessionId, p);
  return p;
}

async function rehydrate(sessionId: string): Promise<SessionEntry | null> {
  const row = await loadSessionRowFull(sessionId);
  if (!row) {
    console.log(`[rehydrate] ${sessionId} — no Supabase row, returning null`);
    return null;
  }
  if (row.status !== "active") {
    console.log(`[rehydrate] ${sessionId} — row status=${row.status}, not rehydrating`);
    return null;
  }

  // Deadline guard. If the original window already elapsed during downtime,
  // mark the row completed and skip rehydrate.
  const now = Date.now();
  const deadlineMs = new Date(row.deadline).getTime();
  if (now >= deadlineMs) {
    console.log(`[rehydrate] ${sessionId} — deadline already passed, marking completed`);
    await persistSessionUpdate(sessionId, { status: "completed" });
    return null;
  }

  // Budget guard. The new key gets capped at remaining budget so the
  // candidate doesn't get a fresh full SESSION_BUDGET_USD after a restart.
  const alreadySpent = Number(row.spend_usd ?? 0);
  const remainingBudget = env.SESSION_BUDGET_USD - alreadySpent;
  if (remainingBudget <= 0) {
    console.log(
      `[rehydrate] ${sessionId} — budget exhausted (spent ${alreadySpent}), marking completed`,
    );
    await persistSessionUpdate(sessionId, { status: "completed" });
    return null;
  }

  // E2B reconnect. Mirrors the existing orphanTeardown path (sandbox.ts:262)
  // which is the only proof in the codebase that Sandbox.connect works.
  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.connect(row.sandbox_id);
  } catch (err) {
    console.warn(
      `[rehydrate] ${sessionId} — Sandbox.connect(${row.sandbox_id}) threw, sandbox is gone:`,
      err instanceof Error ? err.message : String(err),
    );
    await persistSessionUpdate(sessionId, { status: "completed" });
    return null;
  }

  // Re-mint the per-session LiteLLM key. Unique alias suffix avoids the
  // LiteLLM uniqueness clash with the original `session-${id}` alias.
  let litellmKey: string;
  try {
    litellmKey = await mintSessionKey(sessionId, {
      aliasOverride: `session-${sessionId}-r${Date.now()}`,
      maxBudgetUsd: remainingBudget,
      durationMinutes: Math.max(1, Math.ceil((deadlineMs - now) / 60_000)),
    });
  } catch (err) {
    console.warn(
      `[rehydrate] ${sessionId} — mintSessionKey failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  // Re-fetch scenario for scenarioMeta (cheap; one Supabase call).
  let scenarioMeta: SessionEntry["scenarioMeta"] = null;
  if (row.scenario_id) {
    const scenario = await loadScenarioById(row.scenario_id);
    if (scenario) {
      scenarioMeta = {
        title:      scenario.title,
        brief:      scenario.brief,
        role:       scenario.role,
        difficulty: scenario.difficulty,
      };
    }
  }

  // Sequence counters — query MAX(seq) from each table so we don't collide
  // with previously-persisted rows.
  const nextSeq = await loadNextEventSeq(sessionId);
  const nextTranscriptSeq = await loadNextTranscriptSeq(sessionId);

  const scenarioState = (row.scenario_state ?? {}) as Record<string, unknown>;
  const personaStateFromRow =
    (scenarioState["personas"] as PersonaState | undefined) ?? DEFAULT_PERSONA_STATE;

  // Re-arm the expiry timer. Fires expireSession at the original deadline,
  // not a fresh `deadline + timeout`.
  const expiryMs = Math.max(0, deadlineMs - now);
  const expiryTimer = setTimeout(() => {
    void expireSession(sessionId, "timeout");
  }, expiryMs);

  const entry: SessionEntry = {
    sandbox,
    sandboxId: row.sandbox_id,
    createdAt: new Date(row.created_at),
    deadline: new Date(row.deadline),
    litellmKey,
    spendTally: alreadySpent,
    status: "active",
    expiryTimer,
    ptySockets: new Set(),

    nextSeq,
    eventBuffer: [],
    flushTimer: null,

    ptyOutputBuffer: [],
    ptyInputBuffer: [],
    ptyOutputFlushTimer: null,
    ptyInputFlushTimer: null,

    lastFileHashes: new Map(),

    systemPromptWritten: true, // assume already done by the original session
    nextTranscriptSeq,

    scenarioId: row.scenario_id,
    scenarioState,
    scenarioMeta,

    messagingSockets: new Set(),
    // TODO(rehydrate): rebuild channelHistory from the transcript table so
    // persona-agent has conversational context after a restart. For now the
    // persona responds without prior turns in memory — degraded but
    // functional; the session continues.
    channelHistory: { client: [], team: [] },
    personaState: personaStateFromRow,
  };

  sessionRegistry.set(sessionId, entry);

  void appendEvent(sessionId, "session.rehydrated", "system", {
    sandboxId: row.sandbox_id,
    remainingBudgetUsd: remainingBudget,
    expiryInMs: expiryMs,
  });

  console.log(
    `[rehydrate] ${sessionId} — restored from Supabase (sandbox=${row.sandbox_id}, ` +
      `remaining=$${remainingBudget.toFixed(2)}, expires in ${Math.round(expiryMs / 1000)}s)`,
  );
  return entry;
}
