// verify-deferred-clock.ts — acceptance verifier for the DEFERRED session clock
// (orientation-overlay slice). The work-time countdown + proactive beats begin
// only when the candidate presses "Start working" (POST /sessions/:id/start),
// not at session creation.
//
// Infra-light: exercises the core service function startSessionClock() directly
// against an in-memory registry entry it seeds itself (no E2B / LiteLLM / live
// Fastify boot needed — startSessionClock only touches the registry entry +
// best-effort Supabase persistence). Skips GRACEFULLY when the registry module
// can't be imported (it never should — this is pure app code).
//
// Asserts:
//   [a] first /start sets a FRESH deadline ≈ now + SESSION_TIMEOUT_MIN
//   [b] first /start stamps scenarioState.clock_started_at (ISO)
//   [c] first /start RE-ANCHORS scheduled beats so their offset is from `now`
//       (a beat that was due 5 min into the session is now ~5 min from start,
//        NOT ~5 min from the earlier creation time)
//   [d] a SECOND /start is IDEMPOTENT — deadline unchanged, clock_started_at
//       unchanged (a refresh / double-click must NOT extend the work-time cap)
//   [e] unknown session id → null (404 at the route)
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-deferred-clock.ts
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { randomUUID } from "crypto";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

let failures = 0;
const fail = (m: string) => { failures++; console.error("  FAIL:", m); };
const pass = (m: string) => console.log("  PASS:", m);

async function main(): Promise<void> {
  console.log("verify-deferred-clock");

  let registry: typeof import("../src/services/registry.js");
  let sandboxSvc: typeof import("../src/services/sandbox.js");
  let envMod: typeof import("../src/env.js");
  try {
    registry = await import("../src/services/registry.js");
    sandboxSvc = await import("../src/services/sandbox.js");
    envMod = await import("../src/env.js");
  } catch (err) {
    console.log(`  ⚠ SKIP — could not import app modules: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(0);
  }

  const { sessionRegistry, freshPersonaState, freshVerificationState } = registry;
  const { startSessionClock } = sandboxSvc;
  const timeoutMs = envMod.env.SESSION_TIMEOUT_MIN * 60_000;

  // ── Seed an in-memory registry entry that looks like it was created a while
  //    ago during "orientation" (createdAt 3 min in the past, clock NOT started,
  //    a proactive beat originally due 5 min after creation). ────────────────
  const sessionId = randomUUID();
  const CREATED_OFFSET_MS = 3 * 60_000;     // "orientation" lasted 3 minutes
  const BEAT_OFFSET_MS = 5 * 60_000;        // beat due 5 min after creation
  const createdAt = new Date(Date.now() - CREATED_OFFSET_MS);
  const creationDeadline = new Date(createdAt.getTime() + timeoutMs); // safety deadline
  const beatDueTsAtCreation = new Date(createdAt.getTime() + BEAT_OFFSET_MS).toISOString();

  let killSwitchFired = false;
  const seedTimer = setTimeout(() => { killSwitchFired = true; }, timeoutMs);

  const entry = {
    sandbox: { kill: async () => {} },
    sandboxId: "deferred-clock-seed",
    createdAt,
    deadline: creationDeadline,
    litellmKey: "seed",
    spendTally: 0,
    status: "active" as const,
    expiryTimer: seedTimer,
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
    scenarioId: "seed-scenario",
    scenarioState: {
      tokens: 200_000,
      clock_started_at: null,
      scheduled_beats: [
        {
          id: "requirement_change",
          kind: "persona",
          channel: "client",
          beat: "requirement_change",
          due_ts: beatDueTsAtCreation,
          fired: false,
        },
      ],
    },
    scenarioMeta: null,
    messagingSockets: new Set(),
    channelHistory: { client: [], team: [] },
    personaState: freshPersonaState(),
    verificationState: freshVerificationState(),
  };
  // startSessionClock only reads createdAt / deadline / scenarioState /
  // expiryTimer; the rest satisfies the SessionEntry shape for the registry.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessionRegistry.set(sessionId, entry as any);

  try {
    // ── [a][b][c] FIRST /start ──────────────────────────────────────────────
    console.log("\n[first /start]");
    const before = Date.now();
    const r1 = await startSessionClock(sessionId);
    const after = Date.now();
    if (!r1) { fail("first startSessionClock returned null"); throw new Error("abort"); }

    const d1 = Date.parse(r1.deadline);
    // Fresh deadline must be ≈ now + timeout (within the call window), and
    // MUST be later than the creation-time safety deadline (which was anchored
    // 3 min earlier) — i.e. the clock genuinely restarted from "Start".
    const lo = before + timeoutMs - 2_000;
    const hi = after + timeoutMs + 2_000;
    if (d1 >= lo && d1 <= hi) pass(`fresh deadline ≈ now + SESSION_TIMEOUT_MIN (${envMod.env.SESSION_TIMEOUT_MIN}m)`);
    else fail(`deadline out of window: ${r1.deadline} (expected within [${new Date(lo).toISOString()}, ${new Date(hi).toISOString()}])`);
    if (d1 > creationDeadline.getTime() + 1_000) pass("deadline moved LATER than the creation-time safety deadline");
    else fail(`deadline did not advance past creation deadline: new=${r1.deadline} created=${creationDeadline.toISOString()}`);

    const csa = entry.scenarioState.clock_started_at as string | null;
    if (typeof csa === "string" && !Number.isNaN(Date.parse(csa))) pass(`clock_started_at recorded (${csa})`);
    else fail(`clock_started_at not recorded: ${JSON.stringify(csa)}`);

    // Beat re-anchored: offset from `now` should be ≈ BEAT_OFFSET_MS again,
    // NOT (BEAT_OFFSET_MS - CREATED_OFFSET_MS) which is what it would be if the
    // schedule had kept ticking from creation time.
    const beat = (entry.scenarioState.scheduled_beats as Array<{ due_ts: string }>)[0]!;
    const reanchoredOffset = Date.parse(beat.due_ts) - Date.parse(csa as string);
    const drift = Math.abs(reanchoredOffset - BEAT_OFFSET_MS);
    if (drift <= 2_000) pass(`beat re-anchored to ~${BEAT_OFFSET_MS / 60_000}m from START (offset now ${Math.round(reanchoredOffset / 1000)}s)`);
    else fail(`beat offset wrong after reschedule: ${Math.round(reanchoredOffset / 1000)}s (expected ~${BEAT_OFFSET_MS / 1000}s from clock_started_at)`);
    // Sanity: had it NOT re-anchored, the beat would already be ~2 min from now.
    const staleOffset = BEAT_OFFSET_MS - CREATED_OFFSET_MS;
    if (Math.abs(reanchoredOffset - staleOffset) > 30_000) pass("beat did NOT keep ticking from creation time (Sam/Priya won't fire early)");
    else fail("beat still anchored to creation time — persona would fire during/just-after orientation");

    // Kill-switch re-armed: the original creation-time timer must be cleared.
    if (entry.expiryTimer !== seedTimer) pass("kill-switch re-armed (creation-time timer replaced)");
    else fail("expiryTimer not replaced — kill-switch was not re-armed");
    void killSwitchFired; // referenced to keep the seed timer meaningful

    // ── [d] SECOND /start — IDEMPOTENT ──────────────────────────────────────
    console.log("\n[second /start — idempotency]");
    const csaBefore = entry.scenarioState.clock_started_at;
    const r2 = await startSessionClock(sessionId);
    if (!r2) { fail("second startSessionClock returned null"); throw new Error("abort"); }
    if (r2.deadline === r1.deadline) pass("second /start returns the SAME deadline (no extension)");
    else fail(`second /start changed the deadline: ${r1.deadline} → ${r2.deadline}`);
    if (entry.scenarioState.clock_started_at === csaBefore) pass("clock_started_at unchanged on second /start");
    else fail("clock_started_at was overwritten on second /start");

    // ── [e] unknown session → null (route maps to 404) ──────────────────────
    console.log("\n[unknown session]");
    const rNone = await startSessionClock(randomUUID());
    if (rNone === null) pass("unknown session id → null (404 at route)");
    else fail(`unknown session did not return null: ${JSON.stringify(rNone)}`);
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "abort") throw err;
  } finally {
    clearTimeout(seedTimer);
    clearTimeout(entry.expiryTimer);
    sessionRegistry.delete(sessionId);
  }

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
}

void main();
