import { Sandbox } from "e2b";
import { env } from "../env.js";
import { sessionRegistry } from "./registry.js";
import { mintSessionKey } from "./litellm.js";
import { expireSession } from "./session.js";
import {
  persistSessionCreated,
  loadSessionRow,
  persistSessionUpdate,
  persistScenarioStatePatch,
} from "./db.js";
import { logEvent } from "./telemetry.js";
import { appendEvent } from "./events-direct.js";
import { supabase } from "./supabase.js";
import { loadScenarioById, personaMeta, deliverableComponentMeta, type Scenario } from "./scenarios.js";
import { seedScenarioDataset } from "./dataset-seed.js";
import { renderGuardedReadme, parseTableNames } from "./workspace-readme.js";
import {
  freshVerificationState,
  freshPersonaState,
  personaStateToJson,
  type ScheduledBeat,
} from "./registry.js";

// L4 verification (Slice 5.4b) fires this many ms BEFORE the session deadline,
// so the interactive defense completes while the session is still live (the
// LiteLLM key + sandbox are torn down at the deadline). Tests fast-forward via
// beatTimingOverridesMs["verification"] (an absolute offset from session start).
const VERIFICATION_LEAD_MS = 5 * 60_000;
const VERIFICATION_BEAT_ID = "verification";

interface CurveballJson {
  id?: string;
  trigger?: { time_offset_minutes?: number };
  payload?: { channel?: string; message?: string };
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
 *  Curveballs without a recognised id or a non-numeric offset are skipped.
 *
 *  Exported so POST /sessions/:id/start can RE-COMPUTE the schedule relative to
 *  the moment the candidate presses "Start working" (rather than the creation
 *  time) — otherwise Sam/Priya's proactive beats would tick down during the
 *  orientation phase and could fire before the clock even starts. */
export function computeScheduledBeats(
  scenario: Scenario,
  baseMs: number,
  timeoutMs: number,
  overridesMs: Record<string, number> | undefined,
): ScheduledBeat[] {
  const sessionBand = bandLevel(effectiveBandForSession(scenario.difficulty ?? null));
  const out: ScheduledBeat[] = [];
  for (const raw of (scenario.curveballs ?? []) as CurveballJson[]) {
    if (!raw?.id) continue;
    // Every persona beat is scenario-driven (generic) and beat-id-keyed — any
    // curveball with a valid channel is schedulable; no curveball→flag mapping
    // is required.
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
      generic: true,
      ...(raw.payload?.message ? { payload_message: raw.payload.message } : {}),
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

/** Arm (or re-arm) the orchestrator kill-switch: a single setTimeout that calls
 *  expireSession('timeout') when `deadline` is reached. Clears any timer already
 *  on the registry entry first, so re-arming on POST /sessions/:id/start never
 *  leaves two timers racing. Returns the timer so createSandbox can set it on
 *  the fresh entry it is about to insert (the entry does not exist yet at that
 *  call site). A past/zero-delay deadline fires on the next tick — the standard
 *  setTimeout clamp — matching the deadline-reaper's own late-fire behaviour. */
export function armExpiryTimer(sessionId: string, deadline: Date): ReturnType<typeof setTimeout> {
  const existing = sessionRegistry.get(sessionId);
  if (existing) clearTimeout(existing.expiryTimer);
  const delayMs = Math.max(0, deadline.getTime() - Date.now());
  return setTimeout(() => {
    void expireSession(sessionId, "timeout");
  }, delayMs);
}

export interface StartClockResult {
  deadline: string;   // ISO — the (fresh, or already-set-and-unchanged) deadline
  started: true;
}

/** Begin the DEFERRED session clock. Called by POST /sessions/:id/start when
 *  the candidate presses "Start working" after orientation.
 *
 *  FIRST call: sets deadline = now + SESSION_TIMEOUT_MIN, re-anchors every
 *  proactive beat so its offset-from-start is measured from now (Sam/Priya do
 *  NOT message during orientation), re-arms the kill-switch for the new
 *  deadline, stamps scenarioState.clock_started_at = ISO now, and persists both
 *  the sessions.deadline column and the scenario_state patch.
 *
 *  IDEMPOTENT: if clock_started_at is already set (refresh / double-click), the
 *  EXISTING deadline is returned unchanged — a second press must NOT extend
 *  time. The work-time cap is still exactly SESSION_TIMEOUT_MIN; this only moves
 *  the moment it is measured from (creation → Start). It does not weaken any
 *  cost/time control: the candidate simply gets the full work time for work. */
export async function startSessionClock(sessionId: string): Promise<StartClockResult | null> {
  const entry = sessionRegistry.get(sessionId);
  if (!entry) return null;

  // Idempotency guard — a clock already started returns its live deadline.
  const already = entry.scenarioState["clock_started_at"];
  if (typeof already === "string" && already.length > 0) {
    return { deadline: entry.deadline.toISOString(), started: true };
  }

  const now = Date.now();
  const timeoutMs = env.SESSION_TIMEOUT_MIN * 60_000;
  const newDeadline = new Date(now + timeoutMs);

  // Re-anchor proactive beats: preserve each beat's offset-from-creation (which
  // already encodes any dev/test timing override) but slide the whole schedule
  // so t=0 is `now` rather than session-creation time. Fired beats are left as
  // fired (their due_ts is moved too, but the scheduler skips fired beats). This
  // reuses the exact same offset the scenario+overrides produced at creation —
  // equivalent to re-running computeScheduledBeats with baseMs=now — without
  // needing to reload the scenario or re-thread the override map.
  const createdAtMs = entry.createdAt.getTime();
  const beats = (entry.scenarioState["scheduled_beats"] ?? []) as ScheduledBeat[];
  const rescheduled: ScheduledBeat[] = Array.isArray(beats)
    ? beats.map((b) => {
        const offsetMs = Math.max(0, Date.parse(b.due_ts) - createdAtMs);
        return { ...b, due_ts: new Date(now + offsetMs).toISOString() };
      })
    : [];

  const clockStartedAt = new Date(now).toISOString();
  entry.scenarioState["scheduled_beats"] = rescheduled;
  entry.scenarioState["clock_started_at"] = clockStartedAt;
  entry.deadline = newDeadline;

  // Re-arm the kill-switch for the NEW deadline (clears the creation-time
  // safety timer first — see armExpiryTimer). Store the new handle on the entry.
  entry.expiryTimer = armExpiryTimer(sessionId, newDeadline);

  // Persist: the deadline column (so a rehydrate / recruiter view sees the real
  // work deadline) and the scenario_state keys we own here (clock_started_at +
  // the re-anchored schedule). Best-effort — the in-memory entry is source of
  // truth for the live session; these writes are for durability.
  void persistSessionUpdate(sessionId, { deadline: newDeadline.toISOString() });
  void persistScenarioStatePatch(sessionId, {
    clock_started_at: clockStartedAt,
    scheduled_beats: rescheduled,
  });

  logEvent(sessionId, "session.clock_started", "system", {
    deadline: newDeadline.toISOString(),
    timeoutMin: env.SESSION_TIMEOUT_MIN,
    beatsRescheduled: rescheduled.length,
  });

  return { deadline: newDeadline.toISOString(), started: true };
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
  // P5.1: EFFECTIVE difficulty band the session was routed to at creation
  // (the routed scenario's own difficulty — resolved by routes/sessions.ts
  // via difficulty-routing.ts BEFORE this call). Stamped once on the sessions
  // insert; never updated afterwards (running sessions are never re-routed).
  difficultyBand?: string,
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
        personas: personaStateToJson(freshPersonaState()),
        verification: freshVerificationState(),
        scheduled_beats: scheduledBeats,
        // Deferred clock (orientation overlay): null until the candidate presses
        // "Start working" (POST /sessions/:id/start), which stamps ISO-now here
        // and re-arms the deadline + reschedules beats. GET /sessions/:id
        // surfaces (clock_started_at != null) as `clockStarted` so the web shows
        // a "Ready" state instead of a live countdown until then.
        clock_started_at: null,
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

  // Onboarding README — the candidate's "what do I have and where" map,
  // written AFTER the dataset seed (which wipes the workspace). Guarded:
  // renderGuardedReadme hard-fails if the rendered content contains any
  // ground-truth figure/narrative or a persona never_reveals sentence, so a
  // future scenario edit can't leak an answer into onboarding copy.
  const datasetTables = scenario?.dataset_ref ? parseTableNames(scenario.dataset_ref) : [];
  if (scenario) {
    try {
      await sandbox.files.write("/workspace/README.md", renderGuardedReadme(scenario, datasetTables));
    } catch (err) {
      await sandbox.kill().catch(() => {});
      throw err;
    }
  }

  // SAFETY deadline (do NOT remove): even though the work-time countdown +
  // proactive beats are DEFERRED until the candidate presses "Start working"
  // (POST /sessions/:id/start re-arms this timer for the real deadline), a
  // session abandoned during orientation must still be reaped. This kill-switch
  // therefore fires at now+timeout so the deadline-reaper cleans up an
  // orientation-abandoned session. On /start it is cleared and re-armed for the
  // freshly-computed deadline — the work-time cap remains exactly
  // SESSION_TIMEOUT_MIN, just measured from /start.
  const expiryTimer = armExpiryTimer(sessionId, deadline);

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
          clientPersona: personaMeta(scenario.client_persona),
          teamPersona:   personaMeta(scenario.team_persona),
          datasetTables: datasetTables.length > 0 ? datasetTables : null,
          deliverableComponents: deliverableComponentMeta(scenario.deliverable_spec),
        }
      : null,
    messagingSockets: new Set(),
    chatHistory: [],
    personaState: freshPersonaState(),
    verificationState: freshVerificationState(),
    assistantHistory: [],
  });

  // Persist the sessions row synchronously so FK constraints on telemetry tables
  // are satisfied before any subsequent writes (events, file_snapshots, etc.) land.
  await persistSessionCreated(sessionId, orgId, difficultyBand);

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
