// End-to-end verifier for Week 4.6 — scripted proactive persona beats.
//
// Creates a fast-forwarded fde-db-triage session (beatTimingOverridesMs sets
// Sam at T+3s, Dana at T+15s), opens the messaging WS, sends NO candidate
// messages, and waits for both proactive persona pings. Then sends a single
// reactive follow-up to Sam to confirm the refund hint is not repeated.
//
// Persistence assertions: 2 curveball.fired events, matching
// message.{client|team}.persona rows with proactive:true and token/cost
// metadata, scenario_state.scheduled_beats.fired flipped true on both,
// reveal flags set, scenario_state.tokens unchanged at 200000, cost_ledger
// rows with purpose=proactive_{client,team}.
//
// Run: pnpm exec tsx apps/server/scripts/verify-proactive-beats.ts
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { WebSocket } from "undici";
import WS from "ws";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  (process.env.SUPABASE_PROJECT_REF
    ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co`
    : null);
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL/PROJECT_REF or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const SERVER_URL = process.env.SERVER_URL ?? "http://127.0.0.1:3001";
const SLUG = "fde-db-triage";

// Per-session JWTs minted on POST /sessions. createSession stashes them here;
// every session-scoped HTTP call attaches `Authorization: Bearer <token>` and
// WS connections use `bearer.<token>` as a subprotocol.
const tokens = new Map<string, string>();
function authHeaders(sessionId: string): Record<string, string> {
  const t = tokens.get(sessionId);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// Beat offsets passed to POST /sessions. Real production timings are 30s
// (Sam) and 25min (Dana); we compress to 3s / 15s here so the verifier
// finishes in under a minute.
const SAM_OFFSET_MS = 3_000;
const DANA_OFFSET_MS = 15_000;

// The server's default sweeper tick is 15s. If it hasn't been overridden via
// CRUCIBLE_SCHEDULER_TICK_MS, Sam's beat (due at T+3s) won't fire until the
// next 15s tick boundary — so the verifier must wait up to one full tick
// before declaring a failure. With the eager initial sweep + 15s interval,
// 25s is a safe upper bound for Sam.
const SAM_WAIT_TIMEOUT_MS = 25_000;
const DANA_WAIT_TIMEOUT_MS = 30_000;
const REACTIVE_WAIT_TIMEOUT_MS = 60_000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: WebSocket as any },
});

let failures = 0;
function fail(msg: string): void { failures += 1; console.error("  FAIL:", msg); }
function pass(msg: string): void { console.log("  PASS:", msg); }

function assertNotContains(haystack: string, needle: RegExp, why: string): void {
  if (needle.test(haystack)) fail(`${why} — leaked match for ${needle}: "${haystack.slice(0, 200)}"`);
  else pass(why);
}
function assertContains(haystack: string, needle: RegExp, why: string): void {
  if (needle.test(haystack)) pass(why);
  else fail(`${why} — expected match for ${needle}: "${haystack.slice(0, 200)}"`);
}

interface PersonaMsg {
  channel: "client" | "team";
  role: "persona";
  persona_name: string;
  text: string;
  ts: string;
}
interface ErrMsg { type: "error"; code: string; message: string }
type Inbound = PersonaMsg | ErrMsg;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function openMessagingWs(sessionId: string): Promise<WS> {
  const wsBase = SERVER_URL.replace(/^http/, "ws");
  return new Promise((resolveOpen, rejectOpen) => {
    const token = tokens.get(sessionId);
    const protocols = token ? [`bearer.${token}`] : undefined;
    const ws = new WS(`${wsBase}/messages/${sessionId}`, protocols);
    ws.once("open", () => resolveOpen(ws));
    ws.once("error", (err) => rejectOpen(err));
  });
}

/** Wait for the next inbound message matching the predicate. Inbound messages
 *  that don't match are dropped (they may be relevant to other concurrent
 *  waiters, but this verifier only has one waiter active at a time). */
function awaitInbound(
  ws: WS,
  predicate: (msg: PersonaMsg) => boolean,
  timeoutMs: number,
  what: string,
): Promise<PersonaMsg> {
  return new Promise((resolveAw, rejectAw) => {
    const onMessage = (raw: WS.RawData) => {
      let parsed: Inbound;
      try { parsed = JSON.parse(raw.toString()) as Inbound; } catch { return; }
      if ((parsed as ErrMsg).type === "error") {
        cleanup();
        rejectAw(new Error(`server error: ${(parsed as ErrMsg).message}`));
        return;
      }
      const msg = parsed as PersonaMsg;
      if (predicate(msg)) {
        cleanup();
        resolveAw(msg);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      rejectAw(new Error(`timeout (${timeoutMs}ms) waiting for ${what}`));
    }, timeoutMs);
    function cleanup() { clearTimeout(timer); ws.off("message", onMessage); }
    ws.on("message", onMessage);
  });
}

function sendCandidate(ws: WS, channel: "client" | "team", text: string): void {
  ws.send(JSON.stringify({ channel, text }));
}

// ─── Main ──────────────────────────────────────────────────────────────────

(async () => {
  console.log("verify-proactive-beats");

  const { data: scenarioRow, error: scenErr } = await supabase
    .from("scenarios")
    .select("id")
    .eq("slug", SLUG)
    .single();
  if (scenErr || !scenarioRow) {
    console.error("scenario lookup failed:", scenErr?.message);
    process.exit(1);
  }
  const scenarioId = scenarioRow.id as string;
  console.log(`\n[setup] scenario ${SLUG} → ${scenarioId}`);

  // Cooldown for any rate-limit window from a prior run (free-tier Gemini is
  // 5 req/min shared across all sessions on the same API key).
  console.log(`[setup] cooling down 60s to clear any Gemini free-tier rate-limit window…`);
  await sleep(60_000);

  // Create session WITH per-beat overrides for fast-forward.
  const createRes = await fetch(`${SERVER_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scenarioId,
      beatTimingOverridesMs: {
        misleading_teammate_hint: SAM_OFFSET_MS,
        requirement_change:       DANA_OFFSET_MS,
      },
    }),
  });
  if (!createRes.ok) {
    console.error("session create failed:", createRes.status, await createRes.text());
    process.exit(1);
  }
  const { sessionId, token } = (await createRes.json()) as { sessionId: string; token?: string };
  if (token) tokens.set(sessionId, token);
  const sessionStartMs = Date.now();
  console.log(`[setup] session ${sessionId} created (Sam@T+${SAM_OFFSET_MS}ms, Dana@T+${DANA_OFFSET_MS}ms)`);

  const ws = await openMessagingWs(sessionId);
  console.log(`[setup] WS connected at T+${Date.now() - sessionStartMs}ms`);

  // ── Wait for Sam's proactive refund hint (team channel) ─────────────────
  console.log(`\n[a] waiting up to ${SAM_WAIT_TIMEOUT_MS / 1000}s for Sam's proactive ping…`);
  const samMsg = await awaitInbound(
    ws,
    (m) => m.channel === "team",
    SAM_WAIT_TIMEOUT_MS,
    "Sam proactive ping",
  );
  console.log(`  Sam (T+${Date.now() - sessionStartMs}ms): "${samMsg.text}"`);
  assertContains(samMsg.text, /refund/i, "Sam proactive ping leads with refund hypothesis");
  assertNotContains(samMsg.text, /webhook|duplicate|dupe|retry|stripe/i,
    "Sam proactive ping does NOT pre-emptively leak the webhook clue");
  if (samMsg.persona_name === "Sam") pass("Sam proactive ping has persona_name='Sam'");
  else fail(`Sam persona_name = ${JSON.stringify(samMsg.persona_name)}, expected 'Sam'`);

  // ── Wait for Dana's proactive requirement-change (client channel) ───────
  console.log(`\n[b] waiting up to ${DANA_WAIT_TIMEOUT_MS / 1000}s for Dana's proactive ping…`);
  const danaMsg = await awaitInbound(
    ws,
    (m) => m.channel === "client",
    DANA_WAIT_TIMEOUT_MS,
    "Dana proactive ping",
  );
  console.log(`  Dana (T+${Date.now() - sessionStartMs}ms): "${danaMsg.text}"`);
  assertContains(danaMsg.text, /three months|3 months|last 3|board|paragraph|by end/i,
    "Dana proactive ping references the requirement change (3 months / board / end-of-session)");
  if (danaMsg.persona_name === "Dana") pass("Dana proactive ping has persona_name='Dana'");
  else fail(`Dana persona_name = ${JSON.stringify(danaMsg.persona_name)}, expected 'Dana'`);

  // ── Reactive follow-up to Sam — should NOT repeat the refund pitch ──────
  console.log(`\n[c] sending follow-up to Sam ("thanks - any other ideas?"), expecting no refund repeat…`);
  sendCandidate(ws, "team", "thanks - any other ideas to look into besides refunds?");
  try {
    const samReply = await awaitInbound(
      ws,
      (m) => m.channel === "team",
      REACTIVE_WAIT_TIMEOUT_MS,
      "Sam reactive reply",
    );
    console.log(`  Sam: "${samReply.text}"`);
    // Reactive Sam should NOT re-pitch refunds. He's free to mention them in
    // acknowledgement ("yeah refunds was the first thing i tried") but must NOT
    // repeat the original "just filter those out" advice.
    assertNotContains(samReply.text, /just filter|filter (them|those) out|not being subtracted/i,
      "reactive Sam does NOT repeat the refund prescription");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Treat the daily Gemini free-tier quota as a SKIP rather than a FAIL —
    // it's an environmental cap, not a defect. Persistence assertions below
    // still validate the proactive path independently.
    if (/RateLimitError|RESOURCE_EXHAUSTED|quota/i.test(message)) {
      console.log(`  SKIP: Gemini quota hit — reactive suppression check deferred (${message.slice(0, 100)}…)`);
    } else {
      fail(`reactive Sam reply error: ${message}`);
    }
  }

  ws.close();
  await sleep(1_500); // let telemetry buffer flush

  // ── Persistence assertions ──────────────────────────────────────────────
  console.log("\n[d] events table — curveball.fired");
  const { data: curveEvents, error: cerr } = await supabase
    .from("events")
    .select("seq, type, payload")
    .eq("session_id", sessionId)
    .eq("type", "curveball.fired")
    .order("seq", { ascending: true });
  if (cerr) {
    fail(`curveball.fired read failed: ${cerr.message}`);
  } else {
    if (curveEvents!.length === 2) pass("2 curveball.fired events persisted");
    else fail(`expected 2 curveball.fired events, got ${curveEvents!.length}`);

    const ids = curveEvents!.map((e) => (e.payload as Record<string, unknown>).curveball_id).sort();
    const expectedIds = ["misleading_teammate_hint", "requirement_change"];
    if (JSON.stringify(ids) === JSON.stringify(expectedIds))
      pass(`curveball ids match expected: ${ids.join(", ")}`);
    else fail(`curveball ids = ${JSON.stringify(ids)}, expected ${JSON.stringify(expectedIds)}`);

    for (const ev of curveEvents!) {
      const p = ev.payload as Record<string, unknown>;
      if (p.trigger !== "time") {
        fail(`curveball event ${p.curveball_id} trigger = ${JSON.stringify(p.trigger)}, expected 'time'`);
        break;
      }
      if (typeof p.t_offset_ms !== "number") {
        fail(`curveball event ${p.curveball_id} missing t_offset_ms`);
        break;
      }
    }
    if (curveEvents!.every((e) => {
      const p = e.payload as Record<string, unknown>;
      return p.trigger === "time" && typeof p.t_offset_ms === "number";
    })) pass("all curveball.fired events have trigger='time' + t_offset_ms");
  }

  console.log("\n[e] events table — proactive persona messages with metadata");
  const { data: msgEvents, error: merr } = await supabase
    .from("events")
    .select("seq, type, payload")
    .eq("session_id", sessionId)
    .like("type", "message.%.persona")
    .order("seq", { ascending: true });
  if (merr) {
    fail(`message.persona read failed: ${merr.message}`);
  } else {
    const proactiveRows = msgEvents!.filter(
      (e) => (e.payload as Record<string, unknown>).proactive === true,
    );
    if (proactiveRows.length === 2) pass("2 proactive=true persona message events persisted");
    else fail(`expected 2 proactive persona events, got ${proactiveRows.length}`);
    for (const ev of proactiveRows) {
      const p = ev.payload as Record<string, unknown>;
      const ok =
        typeof p.text === "string" &&
        typeof p.persona_name === "string" &&
        p.model === "gemini-flash" &&
        typeof p.prompt_tokens === "number" &&
        typeof p.completion_tokens === "number" &&
        typeof p.total_tokens === "number" &&
        typeof p.latency_ms === "number" &&
        "cost_usd" in p;
      if (!ok) {
        fail(`proactive event payload missing required fields: ${JSON.stringify(p).slice(0, 200)}`);
        break;
      }
    }
    if (proactiveRows.every((e) => {
      const p = e.payload as Record<string, unknown>;
      return p.model === "gemini-flash" && typeof p.prompt_tokens === "number";
    })) pass("proactive persona events carry token/cost/latency metadata");
  }

  console.log("\n[f] scenario_state — scheduled_beats fired + reveal flags");
  const { data: sessionRow, error: sErr } = await supabase
    .from("sessions")
    .select("scenario_state")
    .eq("id", sessionId)
    .single();
  if (sErr || !sessionRow) {
    fail(`session read failed: ${sErr?.message}`);
  } else {
    const ss = sessionRow.scenario_state as Record<string, unknown>;
    const beats = (ss.scheduled_beats ?? []) as Array<Record<string, unknown>>;
    if (beats.length === 2) pass(`scheduled_beats has 2 entries`);
    else fail(`scheduled_beats has ${beats.length}, expected 2`);
    if (beats.every((b) => b.fired === true)) pass("both scheduled_beats fired = true");
    else fail(`scheduled_beats fired status: ${JSON.stringify(beats.map((b) => ({ id: b.id, fired: b.fired })))}`);

    const personas = ss.personas as {
      client?: { revealed_specifics?: boolean; requirement_changed?: boolean };
      team?: { gave_refund_hint?: boolean; gave_webhook_clue?: boolean };
    } | undefined;
    if (personas?.team?.gave_refund_hint === true)
      pass("personas.team.gave_refund_hint = true");
    else fail(`personas.team.gave_refund_hint = ${personas?.team?.gave_refund_hint}, expected true`);
    if (personas?.client?.requirement_changed === true)
      pass("personas.client.requirement_changed = true");
    else fail(`personas.client.requirement_changed = ${personas?.client?.requirement_changed}, expected true`);

    if (ss.tokens === 200000) pass("scenario_state.tokens unchanged (200000 — proactive cost did NOT deduct)");
    else fail(`scenario_state.tokens = ${JSON.stringify(ss.tokens)}, expected 200000`);
  }

  console.log("\n[g] cost_ledger — proactive purpose split");
  const { data: costs, error: csErr } = await supabase
    .from("cost_ledger")
    .select("purpose, cost_usd")
    .eq("session_id", sessionId)
    .order("ts", { ascending: true });
  if (csErr) {
    fail(`cost_ledger read failed: ${csErr.message}`);
  } else {
    const proactiveTeam = costs!.filter((c) => c.purpose === "proactive_team").length;
    const proactiveClient = costs!.filter((c) => c.purpose === "proactive_client").length;
    if (proactiveTeam === 1) pass("1 cost_ledger row with purpose=proactive_team");
    else fail(`expected 1 proactive_team cost row, got ${proactiveTeam}`);
    if (proactiveClient === 1) pass("1 cost_ledger row with purpose=proactive_client");
    else fail(`expected 1 proactive_client cost row, got ${proactiveClient}`);
  }

  // Clean up.
  await fetch(`${SERVER_URL}/sessions/${sessionId}`, { method: "DELETE", headers: { ...authHeaders(sessionId) } }).catch(() => {});

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
