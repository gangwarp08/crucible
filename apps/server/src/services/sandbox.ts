import { Sandbox } from "e2b";
import { env } from "../env.js";
import { sessionRegistry } from "./registry.js";
import { mintSessionKey } from "./litellm.js";
import { expireSession } from "./session.js";
import { persistSessionCreated, loadSessionRow } from "./db.js";
import { logEvent } from "./telemetry.js";
import { appendEvent } from "./events-direct.js";
import { supabase } from "./supabase.js";
import { loadScenarioById, type Scenario } from "./scenarios.js";
import { seedScenarioDataset } from "./dataset-seed.js";
import { freshVerificationState, type ScheduledBeat } from "./registry.js";

// L4 verification (Slice 5.4b) fires this many ms BEFORE the session deadline,
// so the interactive defense completes while the session is still live (the
// LiteLLM key + sandbox are torn down at the deadline). Tests fast-forward via
// beatTimingOverridesMs["verification"] (an absolute offset from session start).
const VERIFICATION_LEAD_MS = 5 * 60_000;
const VERIFICATION_BEAT_ID = "verification";

/** Map a scenario curveball id to the reveal flag it sets when fired. New
 *  curveballs need a row here AND a matching personaState flag. */
const BEAT_FOR_CURVEBALL: Record<string, ScheduledBeat["beat"]> = {
  misleading_teammate_hint: "refund_hint",
  requirement_change:       "requirement_change",
  shortcut_suggestion:      "shortcut_pitch",  // 7.1 product-sense fork
};

interface CurveballJson {
  id?: string;
  trigger?: { time_offset_minutes?: number };
  payload?: { channel?: string };
  difficulty_band?: string;
}

// Difficulty bands, ordered. A session at band N fires every curveball whose
// band is ≤ N (Slice 5.4). A curveball with no band is always-on (back-compat).
const BAND_LEVEL: Record<string, number> = { easy: 0, mid: 1, hard: 2 };

function bandLevel(band: string | null | undefined): number {
  if (!band) return -Infinity; // unbanded → always fires
  return BAND_LEVEL[band] ?? -Infinity;
}

/** v2 seam (NOT implemented in v1): real-time difficulty escalation would bump
 *  a live session's effective band mid-run based on how the candidate is doing,
 *  re-selecting curveballs. v1 fixes the band at session start from the
 *  scenario. Kept as a named hook so the call site exists for v2. */
export function effectiveBandForSession(scenarioBand: string | null): string | null {
  return scenarioBand;
}

/** Compute the proactive-beat schedule from scenario.curveballs at session
 *  start. Per-beat overrides (dev/test) take precedence over the JSON value.
 *  Curveballs without a recognised id or a non-numeric offset are skipped. */
function computeScheduledBeats(
  scenario: Scenario,
  baseMs: number,
  timeoutMs: number,
  overridesMs: Record<string, number> | undefined,
): ScheduledBeat[] {
  const sessionBand = bandLevel(effectiveBandForSession(scenario.difficulty ?? null));
  const out: ScheduledBeat[] = [];
  for (const raw of (scenario.curveballs ?? []) as CurveballJson[]) {
    if (!raw?.id) continue;
    const beat = BEAT_FOR_CURVEBALL[raw.id];
    if (!beat) continue;
    // Difficulty gate: skip curveballs whose band is above this session's band.
    if (bandLevel(raw.difficulty_band) > sessionBand) continue;
    const channel = raw.payload?.channel;
    if (channel !== "client" && channel !== "team") continue;

    const offsetMs =
      overridesMs?.[raw.id] !== undefined
        ? overridesMs[raw.id]!
        : Math.round((raw.trigger?.time_offset_minutes ?? 0) * 60_000);

    out.push({
      id: raw.id,
      kind: "persona",
      channel,
      beat,
      due_ts: new Date(baseMs + offsetMs).toISOString(),
      fired: false,
    });
  }

  // L4 verification beat (Slice 5.4b) — one per scenario-bound session, due
  // VERIFICATION_LEAD_MS before the deadline. GATED: only scheduled when the
  // VERIFICATION_ENABLED flag is on OR a per-session test override is given.
  // Until the candidate-facing verifier UI ships, leaving it off means a real
  // candidate is never asked a question they can't answer (which would read as
  // a weak defense and unfairly cap execution). The test override bypasses the
  // flag so verify-verification still exercises the full path.
  const verifOverride = overridesMs?.[VERIFICATION_BEAT_ID];
  const verificationEnabled = env.VERIFICATION_ENABLED === "true";
  if (verificationEnabled || verifOverride !== undefined) {
    const verifOffsetMs =
      verifOverride !== undefined
        ? verifOverride
        : Math.max(0, timeoutMs - VERIFICATION_LEAD_MS);
    out.push({
      id: VERIFICATION_BEAT_ID,
      kind: "verification",
      channel: "verifier",
      due_ts: new Date(baseMs + verifOffsetMs).toISOString(),
      fired: false,
    });
  }

  return out;
}

/** Provision a new E2B microVM, mint a per-session LiteLLM key, and register both.
 *  Starts the orchestrator kill-switch timer that calls expireSession at deadline.
 *  Persists the session row to Supabase and emits a session.created event.
 *  When scenarioId is provided, the session is tied to that FDE simulation and
 *  scenario_state is initialized from the scenario's game-mechanic constraints. */
export async function createSandbox(
  sessionId: string,
  scenarioId?: string,
  beatTimingOverridesMs?: Record<string, number>,
  tokenBudgetOverride?: number,
  // P2: owning tenant for the sessions row — the session-link's org when a
  // linkToken started the session, else the default org (resolved by caller).
  orgId?: string,
): Promise<string> {
  const timeoutMs = env.SESSION_TIMEOUT_MIN * 60_000;
  const deadline = new Date(Date.now() + timeoutMs);
  const createdAtMs = Date.now();

  // Resolve the scenario (if any) BEFORE booting the sandbox so a bad scenarioId
  // fails fast without burning E2B/LiteLLM resources.
  let scenario: Scenario | null = null;
  let scenarioState: Record<string, unknown> = {};
  if (scenarioId) {
    scenario = await loadScenarioById(scenarioId);
    if (scenario) {
      // Seed the live game-mechanic ledger from the scenario's constraints,
      // plus a per-persona beat-tracking sub-state for the messaging channels.
      // All reveal flags start false — they flip when the persona-agent fires
      // a beat reveal (see services/persona-agent.ts).
      const scheduledBeats = computeScheduledBeats(
        scenario,
        createdAtMs,
        timeoutMs,
        beatTimingOverridesMs,
      );
      scenarioState = {
        ...scenario.constraints,
        personas: {
          client: { revealed_specifics: false, requirement_changed: false },
          team:   { gave_refund_hint: false, gave_webhook_clue: false, gave_shortcut_pitch: false },
        },
        verification: freshVerificationState(),
        scheduled_beats: scheduledBeats,
        // Frozen snapshot of the starting constraint values, so the HUD can
        // show "X / Y" (live / original) without losing the original to the
        // in-place mutations that the token/compute deductions perform on
        // scenarioState.{tokens,compute_minutes,…}.
        budget_initial: { ...scenario.constraints },
      };
      // Dev/test knob: override the scenario's full tokens budget with a
      // tiny value so the assistant can be force-exhausted in a few calls.
      // Production callers omit this; only the verifier script sets it.
      // The override applies to BOTH the live tokens balance AND the initial
      // snapshot — otherwise the HUD would show "500 / 200,000".
      if (tokenBudgetOverride !== undefined) {
        scenarioState = {
          ...scenarioState,
          tokens: tokenBudgetOverride,
          budget_initial: {
            ...(scenarioState["budget_initial"] as Record<string, unknown>),
            tokens: tokenBudgetOverride,
          },
        };
      }
    } else {
      console.warn(
        `[sandbox] scenarioId=${scenarioId} did not resolve — proceeding with empty scenario_state`,
      );
    }
  }

  // H3 (6.8c): default-deny candidate egress. The assessment needs ZERO
  // outbound network from inside the microVM — the dataset is a local SQLite
  // file the server seeds, and every model call is server-proxied
  // (browser → server → LiteLLM), never made from the sandbox. Denying egress
  // removes exfiltration + arbitrary-fetch abuse from untrusted candidate code
  // with no loss of assessment functionality.
  const sandbox = await Sandbox.create("crucible-dev", {
    timeoutMs,
    metadata: { sessionId },
    allowInternetAccess: false,
  });

  let litellmKey: string;
  try {
    litellmKey = await mintSessionKey(sessionId);
  } catch (err) {
    await sandbox.kill().catch(() => {});
    throw err;
  }

  // Seed the per-session SQLite DB when the scenario carries a dataset_ref.
  // Sessions without one (e.g. ad-hoc dev sessions) skip this entirely. A seed
  // failure tears down the sandbox so the caller sees a hard failure rather
  // than a half-provisioned session.
  if (scenario?.dataset_ref) {
    try {
      await seedScenarioDataset(sandbox, scenario.dataset_ref);
    } catch (err) {
      await sandbox.kill().catch(() => {});
      throw err;
    }
  }

  const expiryTimer = setTimeout(() => {
    void expireSession(sessionId, "timeout");
  }, timeoutMs);

  sessionRegistry.set(sessionId, {
    sandbox,
    sandboxId: sandbox.sandboxId,
    createdAt: new Date(),
    deadline,
    litellmKey,
    spendTally: 0,
    status: "active",
    expiryTimer,
    ptySockets: new Set(),
    nextSeq: 0,
    eventBuffer: [],
    flushTimer: null,
    ptyOutputBuffer: [],
    ptyInputBuffer: [],
    ptyOutputBytes: 0,
    ptyInputBytes: 0,
    ptyOutputFlushTimer: null,
    ptyInputFlushTimer: null,
    lastFileHashes: new Map(),
    systemPromptWritten: false,
    nextTranscriptSeq: 0,
    scenarioId: scenarioId ?? null,
    scenarioState,
    scenarioMeta: scenario
      ? {
          title:      scenario.title,
          brief:      scenario.brief,
          role:       scenario.role,
          difficulty: scenario.difficulty,
        }
      : null,
    messagingSockets: new Set(),
    channelHistory: { client: [], team: [] },
    personaState: {
      client: { revealed_specifics: false, requirement_changed: false },
      team:   { gave_refund_hint: false, gave_webhook_clue: false, gave_shortcut_pitch: false },
    },
    verificationState: freshVerificationState(),
  });

  // Persist the sessions row synchronously so FK constraints on telemetry tables
  // are satisfied before any subsequent writes (events, file_snapshots, etc.) land.
  await persistSessionCreated(sessionId, orgId);

  logEvent(sessionId, "session.created", "system", {
    sandboxId: sandbox.sandboxId,
    template: "crucible-dev",
    model: "gemini-flash",
    budgetUsd: env.SESSION_BUDGET_USD,
    timeoutMin: env.SESSION_TIMEOUT_MIN,
    deadline: deadline.toISOString(),
    scenarioId: scenarioId ?? null,
  });

  return sandbox.sandboxId;
}

/** Cancel the orchestrator timer and run expireSession (the shared teardown path).
 *  Called by the manual DELETE /sessions/:id endpoint.
 *
 *  When the in-memory registry entry is missing (server restart, tsx-watch
 *  reload between create and DELETE), falls back to orphanTeardown which
 *  uses the Supabase row as source-of-truth: best-effort sandbox.kill, mark
 *  the row terminal, append a session.ended event. Before this fallback the
 *  silent `if (!entry) return` left the E2B sandbox running until its own
 *  timeout and the sessions row stuck on status='active' indefinitely. */
export async function destroySandbox(
  sessionId: string,
  endReason: "manual" | "budget" = "manual",
): Promise<void> {
  const entry = sessionRegistry.get(sessionId);
  if (entry) {
    clearTimeout(entry.expiryTimer);
    await expireSession(sessionId, endReason);
    return;
  }
  await orphanTeardown(sessionId);
}

/** Orphan-session teardown. Runs when DELETE /sessions/:id lands for a
 *  session whose in-memory entry was dropped. Reads sandbox_id + status
 *  from Supabase, best-effort kills the sandbox via Sandbox.connect, marks
 *  the row terminal, and appends a session.ended event for the recruiter
 *  timeline. Idempotent: a second call sees status='completed' and no-ops.
 *
 *  Skips: LiteLLM key revoke (the key value is only in memory and we have
 *  just the alias here; the key's mint-time TTL bounds the cost), and the
 *  Analysis Agent auto-eval (recruiter can trigger manually via
 *  POST /api/review/sessions/:id/evaluate if they want the scorecard). */
async function orphanTeardown(sessionId: string): Promise<void> {
  const row = await loadSessionRow(sessionId);
  if (!row) {
    console.log(`[orphan-teardown] session ${sessionId} not in Supabase — no-op`);
    return;
  }
  if (row.status !== "active") {
    console.log(
      `[orphan-teardown] session ${sessionId} already terminal (status=${row.status}) — no-op`,
    );
    return;
  }

  console.log(
    `[orphan-teardown] session ${sessionId} — registry miss; killing sandbox ${row.sandbox_id} via Supabase fallback`,
  );

  // Best-effort sandbox kill. Connect can fail if the sandbox is already
  // dead (good — that's the outcome we want); swallow.
  try {
    const sandbox = await Sandbox.connect(row.sandbox_id);
    await sandbox.kill();
  } catch (err) {
    console.log(
      `[orphan-teardown] Sandbox.connect/kill for ${row.sandbox_id} threw (likely already dead):`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Mark the row terminal. endReason='orphaned' is semantically distinct
  // from manual/timeout/budget so /review can flag these sessions.
  const endedAt = new Date();
  const durationMs = endedAt.getTime() - new Date(row.created_at).getTime();
  if (supabase) {
    const { error } = await supabase
      .from("sessions")
      .update({
        status: "completed",
        end_reason: "orphaned",
        ended_at: endedAt.toISOString(),
        duration_ms: durationMs,
        updated_at: endedAt.toISOString(),
      })
      .eq("id", sessionId);
    if (error) {
      console.error("[orphan-teardown] sessions update failed", error.message);
    }
  }

  // Emit session.ended for the recruiter timeline. appendEvent's
  // registry-bypass path (events-direct.ts) writes straight to Supabase
  // with seq = MAX(seq)+1, which is exactly the case here.
  await appendEvent(sessionId, "session.ended", "system", {
    endReason: "orphaned",
    durationMs,
  });
}
