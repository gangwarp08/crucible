// Periodic sweeper for proactive persona beats.
//
// Beat schedules live in sessions.scenario_state.scheduled_beats (jsonb on
// Supabase) — that's the durability point: even if this server process is
// killed mid-session, the schedule survives in the DB. The in-memory part is
// just the sweep loop; once a future "session resume" slice rebuilds
// SessionEntry from Supabase + Sandbox.connect, the persisted beats are
// already waiting.
//
// Per tick the sweeper iterates the live registry, fires any due-unfired
// beat, marks fired:true, and persists. If the reactive persona path
// happened to give the same reveal first (e.g. candidate messaged Sam before
// Sam's proactive ping fired), the matching personaState flag is already
// set and we skip the LLM call — just mark fired:true and persist.

import {
  sessionRegistry,
  personaStateToJson,
  type ScheduledBeat,
  type PersonaState,
  type MessagingSocket,
} from "./registry.js";
import {
  proactiveBeatMessage,
  proactiveBeatMessageGeneric,
  type ProactiveBeat,
} from "./persona-agent.js";
import { startVerification } from "./verifier-agent.js";
import { broadcastToSession } from "./messaging.js";
import { logEvent, recordCost } from "./telemetry.js";
import { persistSessionUpdate, persistScenarioStatePatch } from "./db.js";

const TICK_MS = Number(process.env["CRUCIBLE_SCHEDULER_TICK_MS"]) || 15_000;

let handle: ReturnType<typeof setInterval> | null = null;
let sweepInFlight = false;

export function startBeatScheduler(): void {
  if (handle) return;
  handle = setInterval(() => {
    if (sweepInFlight) return; // prior tick still working; skip
    void sweep();
  }, TICK_MS);
  // Eager initial sweep so beats already due (compressed-time tests, or a
  // future session-resume after the server was down past due_ts) don't have
  // to wait one full tick.
  void sweep();
  console.log(`[scheduler] started (tick=${TICK_MS}ms)`);
}

export function stopBeatScheduler(): void {
  if (handle) {
    clearInterval(handle);
    handle = null;
    console.log("[scheduler] stopped");
  }
}

function beatAlreadyRevealed(beat: ScheduledBeat, state: PersonaState): boolean {
  // Generic (scenario-driven) beats track by beat id in firedBeatIds.
  if (beat.generic) return state.firedBeatIds.has(beat.id);
  // Family-1 beats track via the calibrated boolean flags — UNCHANGED.
  if (beat.beat === "refund_hint") return state.team.gave_refund_hint;
  if (beat.beat === "requirement_change") return state.client.requirement_changed;
  if (beat.beat === "shortcut_pitch") return state.team.gave_shortcut_pitch;
  return false;
}

function applyBeatReveal(state: PersonaState, beat: ScheduledBeat): void {
  if (beat.generic) {
    state.firedBeatIds.add(beat.id);
    return;
  }
  if (beat.beat === "refund_hint") state.team.gave_refund_hint = true;
  if (beat.beat === "requirement_change") state.client.requirement_changed = true;
  if (beat.beat === "shortcut_pitch") state.team.gave_shortcut_pitch = true;
}

async function sweep(): Promise<void> {
  sweepInFlight = true;
  try {
    const now = Date.now();
    for (const [sessionId, entry] of sessionRegistry) {
      if (entry.status === "completed") continue;
      const beats = (entry.scenarioState["scheduled_beats"] ?? []) as ScheduledBeat[];
      if (!Array.isArray(beats) || beats.length === 0) continue;

      let stateChanged = false;
      for (const beat of beats) {
        if (beat.fired) continue;
        if (Date.parse(beat.due_ts) > now) continue;

        // Short-circuit: if the reactive path already gave this reveal, mark
        // the beat fired silently — avoids double-firing the same content.
        // Verification beats have no reveal flag; startVerification is itself
        // idempotent, so they skip this persona-only check.
        if (beat.kind !== "verification" && beatAlreadyRevealed(beat, entry.personaState)) {
          beat.fired = true;
          stateChanged = true;
          console.log(
            `[scheduler] beat ${beat.id} on ${sessionId} already revealed reactively — marking fired without firing`,
          );
          continue;
        }

        try {
          await fireBeat(sessionId, beat);
          beat.fired = true;
          stateChanged = true;
        } catch (err) {
          // Leave fired=false → next tick retries. Log and continue with the
          // next beat / session so one failure doesn't poison the sweep.
          console.error(
            `[scheduler] beat ${beat.id} failed for ${sessionId}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      if (stateChanged) {
        // Patch ONLY the two top-level keys the scheduler owns: personas
        // (reveal flags applied by fireBeat) and scheduled_beats (the
        // per-beat fired booleans, mutated in-place above). The sweep loop
        // is guarded by sweepInFlight so multiple concurrent sweeps can't
        // race; but a parallel token / compute / deliverable write must
        // not lose its key from a whole-object replace here.
        void persistScenarioStatePatch(sessionId, {
          personas: entry.scenarioState["personas"],
          scheduled_beats: entry.scenarioState["scheduled_beats"],
        });
      }
    }
  } finally {
    sweepInFlight = false;
  }
}

async function fireBeat(sessionId: string, beat: ScheduledBeat): Promise<void> {
  const entry = sessionRegistry.get(sessionId);
  if (!entry) throw new Error("session missing from registry");

  // L4 verification beat (Slice 5.4b) — open the interactive defense exchange.
  // startVerification handles its own telemetry, cost accounting, and broadcast.
  if (beat.kind === "verification") {
    await startVerification(sessionId, broadcastToSession);
    return;
  }

  const reply = beat.generic
    ? await proactiveBeatMessageGeneric(
        sessionId,
        beat.channel as "client" | "team",
        beat.id,
        beat.payload_message,
      )
    : await proactiveBeatMessage(
        sessionId,
        beat.channel as "client" | "team",
        beat.beat as ProactiveBeat,
      );

  // Cost accounting — mirrors messaging.ts processOne.
  if (reply.costUsd !== null) entry.spendTally += reply.costUsd;

  // Force-set the matching reveal flag based on the BEAT (not the LLM-
  // reported reveals) — scheduler is source of truth for what fired.
  applyBeatReveal(entry.personaState, beat);

  // Mirror personaState into scenarioState.personas so the recruiter-facing
  // jsonb stays consistent with the in-memory flags. IN-PLACE mutation —
  // the actual persist happens in the sweep loop above via a partial patch
  // covering both personas + scheduled_beats. personaStateToJson serialises
  // the family-1 boolean flags AND the generic firedBeatIds Set (→ string[]).
  const personas = (entry.scenarioState["personas"] ?? {}) as Record<string, unknown>;
  Object.assign(personas, personaStateToJson(entry.personaState));
  entry.scenarioState["personas"] = personas;

  const tOffsetMs = Date.now() - entry.createdAt.getTime();

  logEvent(sessionId, `message.${beat.channel}.persona`, "system", {
    text: reply.text,
    persona_name: reply.personaName,
    reveals: reply.reveals,
    proactive: true,
    model: reply.model,
    prompt_tokens: reply.promptTokens,
    completion_tokens: reply.completionTokens,
    total_tokens: reply.totalTokens,
    cost_usd: reply.costUsd,
    latency_ms: reply.latencyMs,
    litellm_call_id: reply.callId,
    finish_reason: reply.finishReason,
  });

  logEvent(sessionId, "curveball.fired", "system", {
    curveball_id: beat.id,
    channel: beat.channel,
    persona_name: reply.personaName,
    trigger: "time",
    t_offset_ms: tOffsetMs,
  });

  void recordCost(sessionId, {
    model: reply.model,
    promptTokens: reply.promptTokens,
    completionTokens: reply.completionTokens,
    costUsd: reply.costUsd ?? 0,
    cumulativeSpendUsd: entry.spendTally,
    purpose: beat.channel === "client" ? "proactive_client" : "proactive_team",
    ...(reply.callId && { litellmCallId: reply.callId }),
  });

  void persistSessionUpdate(sessionId, { spend_usd: entry.spendTally });

  broadcastToSession(sessionId, {
    // Verification beats returned early above; this path is persona-only.
    channel: beat.channel as "client" | "team",
    role: "persona",
    persona_name: reply.personaName,
    text: reply.text,
    ts: new Date().toISOString(),
  });

  // Silence the unused-import warning for MessagingSocket — its only role is
  // a type re-export consumed via broadcastToSession.
  void (null as unknown as MessagingSocket | null);
}
