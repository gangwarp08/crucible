import { Sandbox } from "e2b";
import { env } from "../env.js";
import { sessionRegistry } from "./registry.js";
import { mintSessionKey } from "./litellm.js";
import { expireSession } from "./session.js";
import { persistSessionCreated } from "./db.js";
import { logEvent } from "./telemetry.js";
import { loadScenarioById, type Scenario } from "./scenarios.js";
import { seedScenarioDataset } from "./dataset-seed.js";
import type { ScheduledBeat } from "./registry.js";

/** Map a scenario curveball id to the reveal flag it sets when fired. New
 *  curveballs need a row here AND a matching personaState flag. */
const BEAT_FOR_CURVEBALL: Record<string, ScheduledBeat["beat"]> = {
  misleading_teammate_hint: "refund_hint",
  requirement_change:       "requirement_change",
};

interface CurveballJson {
  id?: string;
  trigger?: { time_offset_minutes?: number };
  payload?: { channel?: string };
}

/** Compute the proactive-beat schedule from scenario.curveballs at session
 *  start. Per-beat overrides (dev/test) take precedence over the JSON value.
 *  Curveballs without a recognised id or a non-numeric offset are skipped. */
function computeScheduledBeats(
  scenario: Scenario,
  baseMs: number,
  overridesMs: Record<string, number> | undefined,
): ScheduledBeat[] {
  const out: ScheduledBeat[] = [];
  for (const raw of (scenario.curveballs ?? []) as CurveballJson[]) {
    if (!raw?.id) continue;
    const beat = BEAT_FOR_CURVEBALL[raw.id];
    if (!beat) continue;
    const channel = raw.payload?.channel;
    if (channel !== "client" && channel !== "team") continue;

    const offsetMs =
      overridesMs?.[raw.id] !== undefined
        ? overridesMs[raw.id]!
        : Math.round((raw.trigger?.time_offset_minutes ?? 0) * 60_000);

    out.push({
      id: raw.id,
      channel,
      beat,
      due_ts: new Date(baseMs + offsetMs).toISOString(),
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
        beatTimingOverridesMs,
      );
      scenarioState = {
        ...scenario.constraints,
        personas: {
          client: { revealed_specifics: false, requirement_changed: false },
          team:   { gave_refund_hint: false, gave_webhook_clue: false },
        },
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

  const sandbox = await Sandbox.create("crucible-dev", {
    timeoutMs,
    metadata: { sessionId },
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
      team:   { gave_refund_hint: false, gave_webhook_clue: false },
    },
  });

  // Persist the sessions row synchronously so FK constraints on telemetry tables
  // are satisfied before any subsequent writes (events, file_snapshots, etc.) land.
  await persistSessionCreated(sessionId);

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
 *  Called by the manual DELETE /sessions/:id endpoint. */
export async function destroySandbox(
  sessionId: string,
  endReason: "manual" | "budget" = "manual",
): Promise<void> {
  const entry = sessionRegistry.get(sessionId);
  if (!entry) return;
  clearTimeout(entry.expiryTimer);
  await expireSession(sessionId, endReason);
}
