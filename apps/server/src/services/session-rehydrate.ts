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
import {
  sessionRegistry,
  freshVerificationState,
  personaStateFromJson,
  type SessionEntry,
  type VerificationState,
} from "./registry.js";
import {
  loadSessionRowFull,
  loadNextEventSeq,
  loadNextTranscriptSeq,
  persistSessionUpdate,
} from "./db.js";
import { mintSessionKey, revokeSessionKeyByAlias } from "./litellm.js";
import { loadScenarioById, personaMeta } from "./scenarios.js";
import { expireSession } from "./session.js";
import { appendEvent } from "./events-direct.js";

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
    // H6: budget-out during downtime is an unclean terminal → exclude, never a
    // silent zero against the candidate.
    await revokeSessionKeyByAlias(row.litellm_key_alias);
    await persistSessionUpdate(sessionId, {
      status: "completed",
      end_reason: "budget",
      scorable: false,
      exclusion_reason: "excluded_infra",
    });
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
    // H6: the sandbox is unrecoverable → orphaned infra terminal, excluded.
    await revokeSessionKeyByAlias(row.litellm_key_alias);
    await persistSessionUpdate(sessionId, {
      status: "completed",
      end_reason: "orphaned",
      scorable: false,
      exclusion_reason: "excluded_infra",
    });
    return null;
  }

  // H1 (6.8a): rotate the LiteLLM key. Revoke the PRIOR key by its stored alias
  // BEFORE minting the replacement so keys don't accumulate across restarts (a
  // fresh mint per rehydration left the old one live until its TTL). Unique
  // alias suffix avoids the LiteLLM uniqueness clash with the prior alias.
  await revokeSessionKeyByAlias(row.litellm_key_alias);
  const newAlias = `session-${sessionId}-r${Date.now()}`;
  let litellmKey: string;
  try {
    litellmKey = await mintSessionKey(sessionId, {
      aliasOverride: newAlias,
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
  // Persist the rotated alias so the NEXT rehydration revokes THIS key (not the
  // long-gone original) — closes the accumulation gap across repeated restarts.
  await persistSessionUpdate(sessionId, { litellm_key_alias: newAlias }).catch(() => {});

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
        clientPersona: personaMeta(scenario.client_persona),
        teamPersona:   personaMeta(scenario.team_persona),
      };
    }
  }

  // Sequence counters — query MAX(seq) from each table so we don't collide
  // with previously-persisted rows.
  const nextSeq = await loadNextEventSeq(sessionId);
  const nextTranscriptSeq = await loadNextTranscriptSeq(sessionId);

  const scenarioState = (row.scenario_state ?? {}) as Record<string, unknown>;
  const personaStateFromRow = personaStateFromJson(scenarioState["personas"]);
  // Resume any in-flight verification exchange (Slice 5.4b) from the persisted
  // mirror; absent it, start idle so the scheduled beat can open one later.
  const verificationStateFromRow =
    (scenarioState["verification"] as VerificationState | undefined) ?? freshVerificationState();

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
    ptyOutputBytes: 0,
    ptyInputBytes: 0,
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
    verificationState: verificationStateFromRow,
    // Rolling assistant context is in-memory only; a rehydrated session starts
    // its window fresh (acceptable — see SessionEntry.assistantHistory).
    assistantHistory: [],
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
