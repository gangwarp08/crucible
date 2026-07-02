// verify-fork-content.ts — Slice 7.1 acceptance (Product-Sense shortcut fork).
//
// Creates a fast-forwarded session on the dev clone `fde-db-triage-fork`, opens
// the messaging WS, sends NO candidate messages, and asserts Sam's proactive
// SHORTCUT beat fires on schedule + is delivered on the team channel with the
// "ship the raw number / skip dedup" framing (and does NOT leak the answer).
// Persistence: curveball.fired for shortcut_suggestion, scheduled_beats fired,
// personas.team.gave_shortcut_pitch = true.
//
// Run: pnpm exec tsx scripts/verify-fork-content.ts
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
  (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : null);
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL/PROJECT_REF or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const SERVER_URL = process.env.SERVER_URL ?? "http://127.0.0.1:3001";
const SLUG = "fde-db-triage-fork";
const COOLDOWN_MS = Number(process.env.FORK_COOLDOWN_MS ?? "60000");

// Fire the shortcut beat at T+3s; push the refund hint out past the test window
// so the first team message we see is unambiguously the shortcut pitch.
const SHORTCUT_OFFSET_MS = 3_000;
const REFUND_OFFSET_MS = 120_000;
const SHORTCUT_WAIT_TIMEOUT_MS = 25_000; // one sweeper tick + headroom

const tokens = new Map<string, string>();
function authHeaders(sessionId: string): Record<string, string> {
  const t = tokens.get(sessionId);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: WebSocket as any },
});

let failures = 0;
function fail(msg: string): void { failures += 1; console.error("  FAIL:", msg); }
function pass(msg: string): void { console.log("  PASS:", msg); }
function assertContains(h: string, n: RegExp, why: string): void {
  if (n.test(h)) pass(why); else fail(`${why} — expected ${n}: "${h.slice(0, 200)}"`);
}
function assertNotContains(h: string, n: RegExp, why: string): void {
  if (n.test(h)) fail(`${why} — leaked ${n}: "${h.slice(0, 200)}"`); else pass(why);
}

interface PersonaMsg { channel: "client" | "team"; role: "persona"; persona_name: string; text: string; ts: string }
interface ErrMsg { type: "error"; code: string; message: string }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function openMessagingWs(sessionId: string): Promise<WS> {
  const wsBase = SERVER_URL.replace(/^http/, "ws");
  return new Promise((res, rej) => {
    const token = tokens.get(sessionId);
    const ws = new WS(`${wsBase}/messages/${sessionId}`, token ? [`bearer.${token}`] : undefined);
    ws.once("open", () => res(ws));
    ws.once("error", (err) => rej(err));
  });
}
function awaitInbound(ws: WS, predicate: (m: PersonaMsg) => boolean, timeoutMs: number, what: string): Promise<PersonaMsg> {
  return new Promise((res, rej) => {
    const onMessage = (raw: WS.RawData) => {
      let parsed: PersonaMsg | ErrMsg;
      try { parsed = JSON.parse(raw.toString()); } catch { return; }
      if ((parsed as ErrMsg).type === "error") { cleanup(); rej(new Error(`server error: ${(parsed as ErrMsg).message}`)); return; }
      const msg = parsed as PersonaMsg;
      if (predicate(msg)) { cleanup(); res(msg); }
    };
    const timer = setTimeout(() => { cleanup(); rej(new Error(`timeout (${timeoutMs}ms) waiting for ${what}`)); }, timeoutMs);
    function cleanup() { clearTimeout(timer); ws.off("message", onMessage); }
    ws.on("message", onMessage);
  });
}

(async () => {
  console.log("verify-fork-content — Slice 7.1 (product-sense shortcut fork)");

  const { data: scen, error: scenErr } = await supabase.from("scenarios").select("id").eq("slug", SLUG).maybeSingle();
  if (scenErr || !scen) {
    // The fork is staged on a dev clone until 7.5 go-live; skip (non-failing)
    // where the clone hasn't been seeded rather than break the suite.
    console.log(`  ⚠ SKIP — scenario '${SLUG}' not present (run scripts/seed-fork-scenario.ts). ${scenErr?.message ?? ""}`);
    process.exit(0);
  }
  const scenarioId = scen.id as string;
  console.log(`\n[setup] scenario ${SLUG} → ${scenarioId}`);

  if (COOLDOWN_MS > 0) {
    console.log(`[setup] cooling down ${COOLDOWN_MS / 1000}s for the Gemini free-tier window…`);
    await sleep(COOLDOWN_MS);
  }

  const createRes = await fetch(`${SERVER_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scenarioId,
      beatTimingOverridesMs: {
        shortcut_suggestion:      SHORTCUT_OFFSET_MS,
        misleading_teammate_hint: REFUND_OFFSET_MS,
      },
    }),
  });
  if (!createRes.ok) { console.error("session create failed:", createRes.status, await createRes.text()); process.exit(1); }
  const { sessionId, token } = (await createRes.json()) as { sessionId: string; token?: string };
  if (token) tokens.set(sessionId, token);
  const t0 = Date.now();
  console.log(`[setup] session ${sessionId} created (shortcut@T+${SHORTCUT_OFFSET_MS}ms)`);

  const ws = await openMessagingWs(sessionId);

  // ── Wait for Sam's proactive SHORTCUT pitch (team channel) ──────────────
  console.log(`\n[a] waiting up to ${SHORTCUT_WAIT_TIMEOUT_MS / 1000}s for Sam's shortcut pitch…`);
  const shortcut = await awaitInbound(ws, (m) => m.channel === "team", SHORTCUT_WAIT_TIMEOUT_MS, "Sam shortcut pitch");
  console.log(`  Sam (T+${Date.now() - t0}ms): "${shortcut.text}"`);
  assertContains(shortcut.text, /ship|raw|skip|dedup|reconcil|overkill|just send|good enough|close enough|those numbers/i,
    "Sam's pitch proposes the ship-the-raw-number shortcut");
  assertNotContains(shortcut.text, /webhook|external_payment_id|MIN\(id\)|duplicate.*key/i,
    "shortcut pitch does NOT leak the dedup answer");
  if (shortcut.persona_name === "Sam") pass("shortcut pitch persona_name='Sam'");
  else fail(`persona_name = ${JSON.stringify(shortcut.persona_name)}, expected 'Sam'`);

  ws.close();
  await sleep(1_500);

  // ── Persistence ─────────────────────────────────────────────────────────
  console.log("\n[b] events — curveball.fired for shortcut_suggestion");
  const { data: curve } = await supabase.from("events").select("payload").eq("session_id", sessionId).eq("type", "curveball.fired");
  const shortcutFired = (curve ?? []).some((e) => (e.payload as Record<string, unknown>).curveball_id === "shortcut_suggestion");
  if (shortcutFired) pass("curveball.fired for shortcut_suggestion persisted");
  else fail(`no shortcut_suggestion curveball.fired (got ${JSON.stringify((curve ?? []).map((e) => (e.payload as Record<string, unknown>).curveball_id))})`);

  console.log("\n[c] scenario_state — beat fired + gave_shortcut_pitch");
  const { data: sess } = await supabase.from("sessions").select("scenario_state").eq("id", sessionId).single();
  const ss = (sess?.scenario_state ?? {}) as Record<string, unknown>;
  const beats = (ss.scheduled_beats ?? []) as Array<Record<string, unknown>>;
  const shortcutBeat = beats.find((b) => b.id === "shortcut_suggestion");
  if (shortcutBeat?.fired === true) pass("scheduled_beats shortcut_suggestion fired = true");
  else fail(`shortcut_suggestion beat fired = ${JSON.stringify(shortcutBeat?.fired)}, expected true`);
  const team = (ss.personas as { team?: { gave_shortcut_pitch?: boolean } } | undefined)?.team;
  if (team?.gave_shortcut_pitch === true) pass("personas.team.gave_shortcut_pitch = true");
  else fail(`personas.team.gave_shortcut_pitch = ${team?.gave_shortcut_pitch}, expected true`);

  await fetch(`${SERVER_URL}/sessions/${sessionId}`, { method: "DELETE", headers: { ...authHeaders(sessionId) } }).catch(() => {});

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
