// End-to-end verifier for the UNIFIED persona chat (shared conversation
// context). Creates a fresh fde-db-triage session and drives one conversation
// across both personas over the messaging WebSocket, asserting:
//
//   1. SHARED CONTEXT — a distinctive fact told to the CLIENT is visible to
//      the TEAM persona (Sam can answer "what did I just tell Dana?").
//   2. KNOWLEDGE BOUNDARY — technical detail discussed with the TEAM persona
//      does not turn the CLIENT technical (Dana never parrots SQL specifics).
//   3. PROMPT HYGIENE — no persona reply leaks the bracketed speaker-prefix
//      convention ("[Candidate → …]" / "[Sam wrote]: …").
//   4. WIRE/TELEMETRY INVARIANCE — events are still exactly
//      message.{client|team}.{candidate|persona} with text payloads (the
//      channel plumbing that scoring depends on is unchanged).
//
// Run: pnpm exec tsx apps/server/scripts/verify-shared-context.ts
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
// 127.0.0.1 (not localhost) to dodge Node 18's IPv6-first resolver.
const SERVER_URL = process.env.SERVER_URL ?? "http://127.0.0.1:3001";
const SLUG = "fde-db-triage";

const tokens = new Map<string, string>();

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: WebSocket as any },
});

let failures = 0;
function fail(msg: string): void {
  failures += 1;
  console.error("  FAIL:", msg);
}
function pass(msg: string): void {
  console.log("  PASS:", msg);
}

function assertNotContains(haystack: string, needle: RegExp | string, why: string): void {
  const re = needle instanceof RegExp ? needle : new RegExp(needle, "i");
  if (re.test(haystack)) fail(`${why} — text leaked match for ${re}: "${haystack.slice(0, 200)}"`);
  else pass(why);
}

function assertContains(haystack: string, needle: RegExp | string, why: string): void {
  const re = needle instanceof RegExp ? needle : new RegExp(needle, "i");
  if (re.test(haystack)) pass(why);
  else fail(`${why} — expected match for ${re} in: "${haystack.slice(0, 200)}"`);
}

interface PersonaResponse {
  channel: "client" | "team";
  role: "persona";
  persona_name: string;
  text: string;
  ts: string;
}
interface ErrorResponse {
  type: "error";
  code: string;
  message: string;
}
type Inbound = PersonaResponse | ErrorResponse;

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

// Gemini free-tier caps generate_content at 5 requests/minute.
const FREE_TIER_DELAY_MS = 13_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function ask(
  ws: WS,
  channel: "client" | "team",
  text: string,
  timeoutMs = 90_000,
): Promise<PersonaResponse> {
  return new Promise((resolveAsk, rejectAsk) => {
    const onMessage = (raw: WS.RawData) => {
      let parsed: Inbound;
      try {
        parsed = JSON.parse(raw.toString()) as Inbound;
      } catch {
        return;
      }
      if ((parsed as ErrorResponse).type === "error") {
        cleanup();
        rejectAsk(new Error(`server error: ${(parsed as ErrorResponse).message}`));
        return;
      }
      const reply = parsed as PersonaResponse;
      if (reply.channel === channel && reply.role === "persona") {
        cleanup();
        resolveAsk(reply);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      rejectAsk(new Error(`timeout waiting for ${channel} reply`));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      ws.off("message", onMessage);
    }
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ channel, text }));
  });
}

/** Every persona reply must be free of the bracket-prefix convention. */
function assertNoSpeakerTag(reply: PersonaResponse, label: string): void {
  if (reply.text.trimStart().startsWith("[")) {
    fail(`${label}: reply leaks a bracketed speaker tag: "${reply.text.slice(0, 120)}"`);
  } else {
    pass(`${label}: no speaker-tag leak`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

(async () => {
  console.log("verify-shared-context");

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

  // Push proactive beats past session end — this verifier exercises only the
  // reactive path, and a mid-run proactive ping would skew the event counts.
  const createRes = await fetch(`${SERVER_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scenarioId,
      beatTimingOverridesMs: {
        misleading_teammate_hint: 3_600_000,
        requirement_change:       3_600_000,
      },
    }),
  });
  if (!createRes.ok) {
    console.error("session create failed:", createRes.status, await createRes.text());
    process.exit(1);
  }
  const { sessionId, token } = (await createRes.json()) as { sessionId: string; token?: string };
  if (token) tokens.set(sessionId, token);
  console.log(`[setup] session ${sessionId} created`);

  const ws = await openMessagingWs(sessionId);
  console.log(`[setup] WS connected`);

  console.log(`[setup] cooling down 60s for rate-limit window to clear…`);
  await sleep(60_000);

  // ── 1. Distinctive fact to the CLIENT ────────────────────────────────────
  console.log("\n[1] tell Dana a distinctive fact (codeword: KINGFISHER)");
  const r1 = await ask(
    ws,
    "client",
    "Hi Dana — quick status. Internally I'm calling this investigation KINGFISHER. I'll have corrected figures for you by 3pm.",
  );
  console.log(`  Dana: "${r1.text.slice(0, 160)}"`);
  assertNoSpeakerTag(r1, "client reply 1");
  await sleep(FREE_TIER_DELAY_MS);

  // ── 2. SHARED CONTEXT: Sam saw the message to Dana ───────────────────────
  console.log("\n[2] ask Sam what codeword was mentioned to Dana");
  const r2 = await ask(
    ws,
    "team",
    "hey Sam — sanity check that you're seeing this channel: what codeword did I mention to Dana a moment ago?",
  );
  console.log(`  Sam: "${r2.text.slice(0, 160)}"`);
  assertContains(r2.text, /kingfisher/i, "shared context: Sam can see the candidate's message to Dana");
  assertNoSpeakerTag(r2, "team reply 1");
  await sleep(FREE_TIER_DELAY_MS);

  // ── 3. Technical detail to the TEAM persona ──────────────────────────────
  console.log("\n[3] discuss technical SQL detail with Sam");
  const r3 = await ask(
    ws,
    "team",
    "current theory: duplicate payment rows. plan is dedup via ROW_NUMBER() partitioned by external_payment_id and keep rn=1. sound right?",
  );
  console.log(`  Sam: "${r3.text.slice(0, 160)}"`);
  assertNoSpeakerTag(r3, "team reply 2");
  await sleep(FREE_TIER_DELAY_MS);

  // ── 4. KNOWLEDGE BOUNDARY: Dana saw it but stays non-technical ───────────
  console.log("\n[4] ask Dana about the technical fix described to Sam");
  const r4 = await ask(
    ws,
    "client",
    "Dana — you probably saw my note to Sam. Can you explain back to me the technical fix I described, so I know you're across it?",
  );
  console.log(`  Dana: "${r4.text.slice(0, 160)}"`);
  assertNotContains(r4.text, /ROW_NUMBER/i, "boundary: Dana does not parrot SQL functions");
  assertNotContains(r4.text, /external_payment_id/i, "boundary: Dana does not parrot schema columns");
  assertNoSpeakerTag(r4, "client reply 2");

  // ── 5. Telemetry invariance ──────────────────────────────────────────────
  console.log("\n[5] events table: channel-typed message rows unchanged");
  await sleep(2_000); // allow the event buffer to flush
  const { data: events, error: evErr } = await supabase
    .from("events")
    .select("type, actor, payload")
    .eq("session_id", sessionId)
    .like("type", "message.%")
    .order("seq", { ascending: true });
  if (evErr || !events) {
    fail(`events fetch failed: ${evErr?.message}`);
  } else {
    const validTypes = new Set([
      "message.client.candidate",
      "message.client.persona",
      "message.team.candidate",
      "message.team.persona",
    ]);
    const badType = events.find((e) => !validTypes.has(e.type as string));
    if (badType) fail(`unexpected message event type: ${badType.type}`);
    else pass(`all ${events.length} message events carry the channel-typed names`);

    const candidateCount = events.filter((e) => (e.type as string).endsWith(".candidate")).length;
    const personaCount = events.filter((e) => (e.type as string).endsWith(".persona")).length;
    if (candidateCount === 4 && personaCount === 4) {
      pass("4 candidate + 4 persona message events persisted");
    } else {
      fail(`expected 4+4 message events, got ${candidateCount} candidate + ${personaCount} persona`);
    }

    const missingText = events.find(
      (e) => typeof (e.payload as Record<string, unknown> | null)?.["text"] !== "string",
    );
    if (missingText) fail(`event ${missingText.type} missing payload.text`);
    else pass("every message event carries payload.text");
  }

  ws.close();

  console.log(failures === 0 ? "\nverify-shared-context: ALL PASS" : `\nverify-shared-context: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("verify-shared-context crashed:", err);
  process.exit(1);
});
