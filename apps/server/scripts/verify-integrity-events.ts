// Acceptance verifier for Slice P1.1 — integrity-event ingest.
//
// Infra-light (no server boot, no E2B, no LLM): seeds a synthetic session row,
// simulates the ingest path — Zod validation (shared IntegrityEventSchema) +
// the exported per-session rate limiter (admitIntegrityEvents) — and inserts
// the ADMITTED events directly via the service-role client, mimicking what
// logEvent persists (monotonic seq, actor "candidate"). Asserts:
//   [a] schema accepts every taxonomy type + rejects malformed payloads
//   [b] rate-limit caps: 60/min total admitted per session, low-signal types
//       capped at 40/min (20/min headroom reserved for high-signal types),
//       floods dropped, window reset re-admits
//   [c] persisted rows: monotonic seq, types survive round-trip,
//       flood-drop reflected in row count
// Self-cleans. Exit 0 on PASS, 1 on FAIL.
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-integrity-events.ts
import { config as loadEnv } from "dotenv";
import { randomUUID } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { WebSocket } from "undici";
import { IntegrityEventSchema, INTEGRITY_EVENT_TYPES, type IntegrityEvent } from "@crucible/shared";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : null);
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("Missing SUPABASE env"); process.exit(1); }

// Dynamic import AFTER dotenv — the route module transitively imports env.ts.
const integrity = await import("../src/routes/integrity.js");
const {
  admitIntegrityEvents,
  resetIntegrityLimiter,
  INTEGRITY_EVENTS_PER_MIN,
  INTEGRITY_LOW_SIGNAL_PER_MIN,
  INTEGRITY_BATCH_MAX,
} = integrity;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: WebSocket as any },
});

let failures = 0;
const fail = (m: string) => { failures++; console.error("  FAIL:", m); };
const pass = (m: string) => console.log("  PASS:", m);
const check = (m: string, ok: boolean, detail?: string) =>
  ok ? pass(m) : fail(`${m}${detail ? ` — ${detail}` : ""}`);

const SID = "00000000-0000-4000-8000-00000000b101";

async function seedSession(): Promise<string | null> {
  const { error } = await supabase.from("sessions").insert({
    id: SID, status: "active", sandbox_id: "verify-integrity", template: "crucible-dev",
    litellm_key_alias: "vi", model: "gemini-flash", budget_usd: 1.0, timeout_min: 60,
    deadline: "2030-01-01T00:00:00.000Z", scenario_state: {},
  });
  return error ? error.message : null;
}
async function cleanup() {
  await supabase.from("events").delete().eq("session_id", SID);
  await supabase.from("sessions").delete().eq("id", SID);
}

/** One valid sample event per taxonomy type. */
function sampleEvent(type: (typeof INTEGRITY_EVENT_TYPES)[number], ts: number): IntegrityEvent {
  switch (type) {
    case "integrity.paste_burst":
      return { type, ts, payload: { chars: 1200, target: "editor" } };
    case "integrity.idle_gap":
      return { type, ts, payload: { ms: 180_000 } };
    case "integrity.copy":
      return { type, ts, payload: { source: "brief", chars: 300 } };
    default:
      return { type, ts } as IntegrityEvent;
  }
}

(async () => {
  console.log("verify-integrity-events — P1.1");
  await cleanup();

  // [a] shared schema — taxonomy round-trip + malformed rejection
  console.log("\n[a] IntegrityEventSchema");
  check("taxonomy has the 8 spec types", INTEGRITY_EVENT_TYPES.length === 8);
  for (const t of INTEGRITY_EVENT_TYPES) {
    const r = IntegrityEventSchema.safeParse(sampleEvent(t, Date.now()));
    check(`accepts ${t}`, r.success, r.success ? "" : JSON.stringify(r.error.issues[0]));
  }
  const badCases: Array<[string, unknown]> = [
    ["unknown type rejected", { type: "integrity.webcam", payload: {} }],
    ["non-integrity type rejected", { type: "db.query", payload: { sql: "select 1" } }],
    ["paste_burst chars=0 rejected", { type: "integrity.paste_burst", payload: { chars: 0, target: "editor" } }],
    ["paste_burst chars>1e6 rejected", { type: "integrity.paste_burst", payload: { chars: 2_000_000, target: "editor" } }],
    ["paste_burst bad target rejected", { type: "integrity.paste_burst", payload: { chars: 10, target: "terminal" } }],
    ["idle_gap non-int ms rejected", { type: "integrity.idle_gap", payload: { ms: 1.5 } }],
    ["copy bad source rejected", { type: "integrity.copy", payload: { source: "google", chars: 10 } }],
  ];
  for (const [name, input] of badCases) {
    check(name, !IntegrityEventSchema.safeParse(input).success);
  }

  // [b] server-side rate limiter — 60/min total, 40/min low-signal,
  //     flood drop, window reset
  console.log("\n[b] rate-limit caps");
  resetIntegrityLimiter();
  const t0 = Date.now();
  const highTypes = (n: number) => Array.from({ length: n }, () => "integrity.paste_burst");
  const lowTypes = (n: number) => Array.from({ length: n }, () => "integrity.tab_blur");
  const nAdmitted = (flags: boolean[]) => flags.filter(Boolean).length;
  check(`batch max is ${INTEGRITY_BATCH_MAX}`, INTEGRITY_BATCH_MAX === 20);
  // 4 high-signal batches of 20 inside one window → 20+20+20+0 admitted
  const admittedPerBatch = [0, 1, 2, 3].map(() =>
    nAdmitted(admitIntegrityEvents(SID, highTypes(20), t0)));
  const totalAdmitted = admittedPerBatch.reduce((s, n) => s + n, 0);
  check(
    `flood of 80 in one window → exactly ${INTEGRITY_EVENTS_PER_MIN} admitted`,
    totalAdmitted === INTEGRITY_EVENTS_PER_MIN,
    `admitted=${JSON.stringify(admittedPerBatch)}`,
  );
  check("4th batch fully dropped", admittedPerBatch[3] === 0);
  // low-signal cap: 40/min, leaving 20/min headroom for high-signal types
  resetIntegrityLimiter(SID);
  check(
    `low-signal flood of 60 → exactly ${INTEGRITY_LOW_SIGNAL_PER_MIN} admitted`,
    nAdmitted(admitIntegrityEvents(SID, lowTypes(60), t0)) === INTEGRITY_LOW_SIGNAL_PER_MIN,
  );
  check("high-signal headroom (20) preserved after low-signal flood",
    nAdmitted(admitIntegrityEvents(SID, highTypes(20), t0)) === 20);
  check("window exhausted after headroom used",
    nAdmitted(admitIntegrityEvents(SID, [...lowTypes(5), ...highTypes(5)], t0)) === 0);
  // partial admit at the boundary
  resetIntegrityLimiter(SID);
  admitIntegrityEvents(SID, highTypes(55), t0);
  check("boundary batch partially admitted (55 then 20 → 5)",
    nAdmitted(admitIntegrityEvents(SID, highTypes(20), t0)) === 5);
  // window reset re-admits
  check("next minute window re-admits",
    nAdmitted(admitIntegrityEvents(SID, highTypes(20), t0 + 61_000)) === 20);
  // other sessions unaffected
  check("cap is per-session (other session admits freely)",
    nAdmitted(admitIntegrityEvents("00000000-0000-4000-8000-00000000b102", highTypes(20), t0)) === 20);
  resetIntegrityLimiter();

  // [c] persistence — mimic ingest for the ADMITTED events of an 80-event flood
  console.log("\n[c] persisted rows (mimicked ingest)");
  const seedErr = await seedSession();
  if (seedErr) { fail(`seed session: ${seedErr}`); await cleanup(); process.exit(1); }

  const tFlood = Date.now();
  let nextSeq = 0; // mirrors sessionRegistry entry.nextSeq for a fresh session
  const rows: Array<Record<string, unknown>> = [];
  for (let batch = 0; batch < 4; batch++) {
    const events = Array.from({ length: 20 }, (_, i) =>
      sampleEvent(INTEGRITY_EVENT_TYPES[(batch * 20 + i) % INTEGRITY_EVENT_TYPES.length]!, tFlood + i),
    );
    // Route logic: validate → admit under caps → logEvent each admitted event.
    // (The rate_capped marker the limiter emits goes through logEvent, which
    // no-ops here — no registry entry — so it doesn't affect row counts.)
    const parsed = events.map((e) => IntegrityEventSchema.parse(e));
    const admitFlags = admitIntegrityEvents(SID, parsed.map((e) => e.type), tFlood);
    parsed.forEach((e, i) => {
      if (!admitFlags[i]) return;
      const payload: Record<string, unknown> = { ...("payload" in e && e.payload ? e.payload : {}) };
      if (e.ts !== undefined) payload.client_ts = e.ts;
      rows.push({
        id: randomUUID(), session_id: SID, seq: nextSeq++, type: e.type,
        actor: "candidate", ts: new Date().toISOString(), payload,
      });
    });
  }
  const { error: insErr } = await supabase.from("events").insert(rows);
  if (insErr) { fail(`events insert: ${insErr.message}`); await cleanup(); process.exit(1); }

  const { data: readBack, error: readErr } = await supabase
    .from("events")
    .select("seq, type, actor, payload")
    .eq("session_id", SID)
    .order("seq", { ascending: true });
  if (readErr || !readBack) { fail(`events read: ${readErr?.message}`); await cleanup(); process.exit(1); }

  check(
    `flood of 80 persisted exactly ${INTEGRITY_EVENTS_PER_MIN} rows (cap drops the rest)`,
    readBack.length === INTEGRITY_EVENTS_PER_MIN,
    `rows=${readBack.length}`,
  );
  const seqs = readBack.map((r) => r.seq as number);
  check("seq strictly monotonic from 0",
    seqs.every((s, i) => s === i), `first=${seqs[0]} last=${seqs[seqs.length - 1]}`);
  const persistedTypes = new Set(readBack.map((r) => r.type as string));
  check("all 8 taxonomy types persisted round-trip",
    INTEGRITY_EVENT_TYPES.every((t) => persistedTypes.has(t)),
    [...persistedTypes].join(","));
  check("every row actor='candidate'", readBack.every((r) => r.actor === "candidate"));
  check("only integrity.* rows written",
    readBack.every((r) => (r.type as string).startsWith("integrity.")));
  const paste = readBack.find((r) => r.type === "integrity.paste_burst");
  const pastePayload = (paste?.payload ?? {}) as Record<string, unknown>;
  check("payload fields persisted (paste_burst chars/target/client_ts)",
    pastePayload.chars === 1200 && pastePayload.target === "editor" && typeof pastePayload.client_ts === "number");

  console.log("\n[cleanup]");
  resetIntegrityLimiter();
  await cleanup();
  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
