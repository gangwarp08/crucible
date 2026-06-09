// End-to-end verifier for Week 4.8 — docs + deliverable + compute HUD.
//
// Creates an fde-db-triage session, asserts:
//   - GET /sessions/:id carries scenarioConstraints (5 fields) and
//     scenarioBalances (tokens + compute_minutes seeded from constraints).
//   - GET /api/sessions/:id/docs returns the 2 docs.
//   - POST /api/sessions/:id/docs/:docId/view persists a doc.view event for each.
//   - POST /api/sessions/:id/deliverable (draft) fires deliverable.draft;
//     latest-wins on a follow-up submit; resubmission allowed.
//   - 3 SELECT queries deduct 0.75 compute_minutes total + 3 constraint.spend events.
//   - PTY input with 2 carriage returns deducts 1.0 compute_minutes + 2 constraint.spend events.
//   - Session is still active after submission (no auto-end).
//
// No Gemini calls — daily-quota concerns from prior verifiers don't apply.
//
// Run: pnpm exec tsx apps/server/scripts/verify-candidate-surfaces.ts
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

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: WebSocket as any },
});

let failures = 0;
function fail(msg: string): void { failures += 1; console.error("  FAIL:", msg); }
function pass(msg: string): void { console.log("  PASS:", msg); }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function asJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

(async () => {
  console.log("verify-candidate-surfaces");

  // 1. Resolve scenario UUID.
  const { data: scenarioRow, error: scenErr } = await supabase
    .from("scenarios").select("id").eq("slug", SLUG).single();
  if (scenErr || !scenarioRow) {
    console.error("scenario lookup failed:", scenErr?.message); process.exit(1);
  }
  const scenarioId = scenarioRow.id as string;

  // 2. Create session.
  const createRes = await fetch(`${SERVER_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenarioId }),
  });
  if (!createRes.ok) {
    console.error("session create failed:", createRes.status, await createRes.text());
    process.exit(1);
  }
  const { sessionId } = (await createRes.json()) as { sessionId: string };
  console.log(`\n[setup] session ${sessionId} created`);

  // ── [a] GET /sessions/:id shape ─────────────────────────────────────────
  console.log("\n[a] GET /sessions/:id");
  const getRes = await fetch(`${SERVER_URL}/sessions/${sessionId}`).then((r) => r.json()) as {
    scenarioConstraints: Record<string, unknown> | null;
    scenarioBalances: Record<string, unknown> | null;
    scenarioTokensRemaining: number | null;
    deliverable: unknown;
  };
  const cons = getRes.scenarioConstraints;
  if (cons && cons.time_minutes === 90 && cons.tokens === 200_000 && cons.compute_minutes === 60 && cons.money_usd === 25 && cons.memory_mb === 2048) {
    pass("scenarioConstraints carries all 5 fields with expected fde-db-triage values");
  } else {
    fail(`scenarioConstraints mismatch: ${JSON.stringify(cons)}`);
  }
  const bal = getRes.scenarioBalances;
  if (bal && bal.tokens === 200_000 && bal.compute_minutes === 60) {
    pass("scenarioBalances seeded from constraints (tokens=200000, compute_minutes=60)");
  } else {
    fail(`scenarioBalances mismatch: ${JSON.stringify(bal)}`);
  }
  if (getRes.deliverable === null) pass("deliverable starts as null");
  else fail(`expected null deliverable on fresh session, got ${JSON.stringify(getRes.deliverable)}`);

  // ── [b] GET /api/sessions/:id/docs ──────────────────────────────────────
  console.log("\n[b] GET /api/sessions/:id/docs");
  const docsRes = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/docs`).then(asJson) as {
    docs: Array<{ id: string; title: string; body: string }>;
  };
  if (docsRes.docs?.length === 2) pass(`2 docs returned`);
  else fail(`expected 2 docs, got ${docsRes.docs?.length}`);
  const titles = docsRes.docs.map((d) => d.title).sort();
  const wantTitles = ["Meridian Data Dictionary", "Revenue Dashboard Definition"];
  if (JSON.stringify(titles) === JSON.stringify(wantTitles)) pass("doc titles match expected");
  else fail(`doc titles = ${JSON.stringify(titles)}, expected ${JSON.stringify(wantTitles)}`);
  for (const d of docsRes.docs) {
    if (!d.body || d.body.length < 100) {
      fail(`doc "${d.id}" body too short (${d.body?.length ?? 0} chars)`);
      break;
    }
  }
  if (docsRes.docs.every((d) => d.body && d.body.length >= 100)) pass("doc bodies all populated");

  // ── [c] doc.view events ────────────────────────────────────────────────
  console.log("\n[c] POST .../docs/:docId/view fires doc.view");
  for (const docId of ["data-dictionary", "revenue-dashboard-definition"]) {
    const r = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/docs/${docId}/view`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (!r.ok) { fail(`view POST for ${docId} returned ${r.status}`); break; }
  }
  await sleep(1_000);
  const { data: viewEvents } = await supabase
    .from("events").select("seq, type, actor, payload")
    .eq("session_id", sessionId).eq("type", "doc.view")
    .order("seq", { ascending: true });
  if (viewEvents?.length === 2) pass("2 doc.view events persisted");
  else fail(`expected 2 doc.view events, got ${viewEvents?.length}`);
  for (const ev of viewEvents ?? []) {
    const p = ev.payload as Record<string, unknown>;
    if (ev.actor !== "candidate") { fail(`doc.view actor = ${ev.actor}, expected candidate`); break; }
    if (typeof p.doc_id !== "string" || typeof p.title !== "string") {
      fail(`doc.view payload missing doc_id/title: ${JSON.stringify(p)}`); break;
    }
  }
  if (viewEvents?.every((e) => e.actor === "candidate" && typeof (e.payload as Record<string, unknown>).doc_id === "string")) {
    pass("doc.view events carry doc_id + title and actor=candidate");
  }

  // ── [d] Deliverable: draft → submit → resubmit ─────────────────────────
  console.log("\n[d] deliverable draft → submit → resubmit");
  const draft1 = {
    status: "draft" as const,
    data: {
      corrected_monthly_revenue: "WIP — exploring",
      root_cause_finding: "tbd",
      client_facing_summary: "",
      decisions_and_tradeoffs: "",
    },
  };
  let r = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/deliverable`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft1),
  });
  if (r.ok) pass("draft save returned 200");
  else { fail(`draft save returned ${r.status}: ${await r.text()}`); }

  const submit1 = {
    status: "submitted" as const,
    data: {
      corrected_monthly_revenue: "SELECT ... GROUP BY external_payment_id",
      root_cause_finding: "Duplicate succeeded payments inflate the SUM.",
      client_facing_summary: "Numbers were overstated by ~$260K across Apr+May due to a recording bug.",
      decisions_and_tradeoffs: "Kept MIN(id) per external_payment_id; recommended idempotency upstream.",
    },
  };
  r = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/deliverable`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(submit1),
  });
  if (r.ok) pass("submit returned 200");
  else { fail(`submit returned ${r.status}: ${await r.text()}`); }

  const submit2 = {
    status: "submitted" as const,
    data: {
      corrected_monthly_revenue: "REVISED query v2",
      root_cause_finding: "REVISED finding",
      client_facing_summary: "REVISED summary",
      decisions_and_tradeoffs: "REVISED decisions",
    },
  };
  r = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/deliverable`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(submit2),
  });
  if (r.ok) pass("resubmit returned 200");

  await sleep(1_000);
  const { data: delivEvents } = await supabase
    .from("events").select("seq, type, payload")
    .eq("session_id", sessionId).like("type", "deliverable.%")
    .order("seq", { ascending: true });
  const drafts = delivEvents?.filter((e) => e.type === "deliverable.draft").length ?? 0;
  const submits = delivEvents?.filter((e) => e.type === "deliverable.submit").length ?? 0;
  if (drafts === 1) pass("1 deliverable.draft event persisted");
  else fail(`expected 1 deliverable.draft, got ${drafts}`);
  if (submits === 2) pass("2 deliverable.submit events persisted (initial + resubmit)");
  else fail(`expected 2 deliverable.submit, got ${submits}`);

  // Latest-wins in scenario_state.
  const { data: sessRow } = await supabase
    .from("sessions").select("scenario_state, status, ended_at")
    .eq("id", sessionId).single();
  const ss = sessRow!.scenario_state as Record<string, unknown>;
  const persistedDeliverable = ss.deliverable as { status: string; data: { root_cause_finding: string } } | null;
  if (persistedDeliverable?.status === "submitted" && persistedDeliverable.data.root_cause_finding === "REVISED finding") {
    pass("scenario_state.deliverable mirrors latest resubmit (latest-wins)");
  } else {
    fail(`scenario_state.deliverable mismatch: ${JSON.stringify(persistedDeliverable)?.slice(0, 200)}`);
  }
  if (sessRow!.status === "active") pass("session still active after submit (no auto-end)");
  else fail(`session.status = ${sessRow!.status}, expected active`);

  // ── [e] Query deductions ───────────────────────────────────────────────
  console.log("\n[e] 3 SELECT queries deduct 3 × 0.25 compute_minutes");
  const computeBefore = ((ss.compute_minutes as number) ?? 60);
  for (let i = 0; i < 3; i++) {
    const qr = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/query`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT 1" }),
    });
    if (!qr.ok) { fail(`query ${i} returned ${qr.status}`); break; }
  }
  await sleep(1_000);
  const { data: sessRow2 } = await supabase
    .from("sessions").select("scenario_state").eq("id", sessionId).single();
  const ss2 = sessRow2!.scenario_state as Record<string, unknown>;
  const computeAfter3 = ss2.compute_minutes as number;
  const expected3 = computeBefore - 0.75;
  if (Math.abs(computeAfter3 - expected3) < 0.001) {
    pass(`compute_minutes ${computeBefore} → ${computeAfter3} (delta 0.75 = 3 × 0.25)`);
  } else {
    fail(`compute_minutes after 3 queries = ${computeAfter3}, expected ${expected3}`);
  }
  const { data: spendEvents } = await supabase
    .from("events").select("seq, payload").eq("session_id", sessionId)
    .eq("type", "constraint.spend").order("seq", { ascending: true });
  const dbQuerySpends = spendEvents?.filter((e) => {
    const p = e.payload as Record<string, unknown>;
    return p.resource === "compute_minutes" && p.reason === "db_query";
  }) ?? [];
  if (dbQuerySpends.length === 3) pass("3 constraint.spend events with reason=db_query");
  else fail(`expected 3 db_query constraint.spend events, got ${dbQuerySpends.length}`);

  // ── [f] PTY-driven deductions ──────────────────────────────────────────
  console.log("\n[f] PTY input with 2 \\r characters deducts 2 × 0.5 compute_minutes");
  const wsBase = SERVER_URL.replace(/^http/, "ws");
  const pty = await new Promise<WS>((resolveOpen, rejectOpen) => {
    const s = new WS(`${wsBase}/pty/${sessionId}`);
    s.once("open", () => resolveOpen(s));
    s.once("error", (err) => rejectOpen(err));
  });
  // Wait for the server's pty.create to finish + its message handler to attach
  // before pushing input. (The server awaits sandbox.pty.create AFTER socket
  // open but BEFORE socket.on("message") registration.) 2.5s is comfortably
  // above the typical e2b pty.create latency.
  await sleep(2_500);
  pty.send(Buffer.from("ls\r"));
  await sleep(300);
  pty.send(Buffer.from("echo hi\r"));
  await sleep(1_500);
  pty.close();
  await sleep(500);
  const { data: sessRow3 } = await supabase
    .from("sessions").select("scenario_state").eq("id", sessionId).single();
  const ss3 = sessRow3!.scenario_state as Record<string, unknown>;
  const computeAfterPty = ss3.compute_minutes as number;
  const expectedAfterPty = computeAfter3 - 1.0;
  if (Math.abs(computeAfterPty - expectedAfterPty) < 0.001) {
    pass(`compute_minutes ${computeAfter3} → ${computeAfterPty} (delta 1.0 = 2 × 0.5)`);
  } else {
    fail(`compute_minutes after PTY = ${computeAfterPty}, expected ${expectedAfterPty}`);
  }
  const { data: spendEvents2 } = await supabase
    .from("events").select("seq, payload").eq("session_id", sessionId)
    .eq("type", "constraint.spend").order("seq", { ascending: true });
  const cmdSpends = spendEvents2?.filter((e) => {
    const p = e.payload as Record<string, unknown>;
    return p.resource === "compute_minutes" && p.reason === "sandbox_command";
  }) ?? [];
  if (cmdSpends.length === 2) pass("2 constraint.spend events with reason=sandbox_command");
  else fail(`expected 2 sandbox_command constraint.spend events, got ${cmdSpends.length}`);

  // Clean up.
  await fetch(`${SERVER_URL}/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
