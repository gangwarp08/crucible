// Acceptance verifier for Slice 6.2 — RD1 submit-and-lock (closes the live
// gaming hole). Drives a REAL session: submit the deliverable, then assert every
// mutating route is 409 read-only, the deliverable snapshot is immutable, and
// the session is 'submitted'. Needs a running server + E2B (creates one session).
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-submit-lock.ts
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { WebSocket } from "undici";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : null);
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SERVER_URL = process.env.SERVER_URL ?? "http://127.0.0.1:3001";
const INVITE_CODE = process.env.INVITE_CODE;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("Missing SUPABASE env"); process.exit(1); }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: WebSocket as any },
});

let failures = 0;
const fail = (m: string) => { failures++; console.error("  FAIL:", m); };
const pass = (m: string) => console.log("  PASS:", m);
const tokens = new Map<string, string>();
const auth = (sid: string) => ({ Authorization: `Bearer ${tokens.get(sid) ?? ""}` });

(async () => {
  console.log("verify-submit-lock");
  const { data: scen } = await supabase.from("scenarios").select("id").eq("slug", "fde-db-triage").single();
  const scenarioId = (scen as { id: string }).id;

  // Create a real session.
  const cr = await fetch(`${SERVER_URL}/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenarioId, ...(INVITE_CODE ? { inviteCode: INVITE_CODE } : {}) }),
  });
  if (!cr.ok) { console.error("session create failed:", cr.status, await cr.text()); process.exit(1); }
  const { sessionId, token } = (await cr.json()) as { sessionId: string; token: string };
  tokens.set(sessionId, token);
  console.log(`  session ${sessionId}`);
  const J = (extra: Record<string, string> = {}) => ({ "Content-Type": "application/json", ...auth(sessionId), ...extra });

  // [a] while active: a file write succeeds
  console.log("\n[a] writable while active");
  const w1 = await fetch(`${SERVER_URL}/file`, { method: "PUT", headers: J(), body: JSON.stringify({ sessionId, path: "notes.txt", content: "draft" }) });
  if (w1.ok) pass("file write OK while active"); else fail(`pre-submit write failed: ${w1.status}`);

  // [b] submit → locks
  console.log("\n[b] submit");
  const sub = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/deliverable`, {
    method: "POST", headers: J(),
    body: JSON.stringify({ status: "submitted", data: { corrected_monthly_revenue: "x", root_cause_finding: "x", client_facing_summary: "x", decisions_and_tradeoffs: "x" } }),
  });
  const subBody = await sub.json().catch(() => ({}));
  if (sub.ok && (subBody as { locked?: boolean }).locked === true) pass("submit returned locked:true");
  else fail(`submit not locked: ${sub.status} ${JSON.stringify(subBody)}`);

  // [c] every mutating route now 409s
  console.log("\n[c] workspace read-only after submit");
  const fileW = await fetch(`${SERVER_URL}/file`, { method: "PUT", headers: J(), body: JSON.stringify({ sessionId, path: "notes.txt", content: "edit after submit" }) });
  if (fileW.status === 409) pass("file write → 409"); else fail(`file write status ${fileW.status} (expected 409)`);

  const q = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/query`, { method: "POST", headers: J(), body: JSON.stringify({ sql: "SELECT 1" }) });
  if (q.status === 409) pass("query → 409"); else fail(`query status ${q.status} (expected 409)`);

  const c = await fetch(`${SERVER_URL}/api/chat`, { method: "POST", headers: J(), body: JSON.stringify({ sessionId, prompt: "hi" }) });
  if (c.status === 409) pass("AI assistant → 409"); else fail(`chat status ${c.status} (expected 409)`);

  // [d] deliverable immutable (resubmit/draft rejected)
  console.log("\n[d] deliverable immutable");
  const re = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/deliverable`, { method: "POST", headers: J(), body: JSON.stringify({ status: "draft", data: { corrected_monthly_revenue: "tampered", root_cause_finding: "", client_facing_summary: "", decisions_and_tradeoffs: "" } }) });
  if (re.status === 409) pass("re-edit deliverable → 409"); else fail(`re-edit status ${re.status} (expected 409)`);

  // [e] session is 'submitted' + locked_at stamped
  console.log("\n[e] lifecycle state");
  const { data: row } = await supabase.from("sessions").select("status, deliverable_locked_at").eq("id", sessionId).maybeSingle();
  const r = row as { status?: string; deliverable_locked_at?: string | null } | null;
  // 'submitted' when verification is off; 'defending' when VERIFICATION_ENABLED
  // fires the defense immediately on submit (RD2/6.3). Both are locked terminals
  // of the submit transition — either is correct.
  if (r?.status === "submitted" || r?.status === "defending") pass(`session.status = ${r.status} (locked)`);
  else fail(`status=${r?.status} (expected submitted or defending)`);
  if (r?.deliverable_locked_at) pass("deliverable_locked_at stamped"); else fail("no deliverable_locked_at");

  // cleanup: end + delete the session
  await fetch(`${SERVER_URL}/sessions/${sessionId}`, { method: "DELETE", headers: { ...auth(sessionId) } }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  await supabase.from("sessions").delete().eq("id", sessionId);

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
