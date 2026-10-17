/**
 * verify-evidence-questions.ts — slice V8 acceptance.
 *
 * Deterministic, infra-light: exercises the pure moment-selection and
 * parse/grounding core in src/services/evidence-questions.ts. The one-LLM-call
 * path (getOrGenerateQuestions against a real completed session) is covered by
 * the live E2E pass.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-evidence-questions.ts
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const { selectMoments, parseQuestions } = await import(
  "../src/services/evidence-questions.js"
);
type MomentEventRow = import("../src/services/evidence-questions.js").MomentEventRow;

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

const T = "2026-10-11T10:00:00.000Z";
let seq = 0;
function ev(type: string, payload: Record<string, unknown> = {}): MomentEventRow {
  return { seq: ++seq, type, ts: T, payload };
}

console.log("verify-evidence-questions — slice V8\n");

// ── [a] moment selection ─────────────────────────────────────────────────────
{
  console.log("[a] selectMoments");
  seq = 0;
  const events = [
    ev("db.query", { status: "error", sql: "SELECT bogus" }),          // 1
    ev("db.query", { status: "error", sql: "SELECT bogus2" }),         // 2
    ev("db.query", { status: "ok", sql: "SELECT fixed FROM t" }),      // 3 recovery
    ev("curveball.fired", { beat_id: "opening_double_push" }),          // 4
    ev("message.client.candidate", { text: "I think the duplicates explain it" }), // 5
    ev("ai_injection.fired", { id: "inj_scan" }),                       // 6
    ev("ai.assistant.candidate", { text: "isn't a full scan wasteful here?" }),    // 7
    ev("file.write", { path: "analysis.sql", size_bytes: 9000 }),       // 8
    ev("file.write", { path: "notes.md", size_bytes: 120 }),            // 9
    ev("deliverable.submit", { ok: true }),                             // 10
  ];
  const moments = selectMoments(events);
  const kinds = moments.map((m) => m.kind);
  check("curveball_response selected", kinds.includes("curveball_response"));
  check("injection_response selected", kinds.includes("injection_response"));
  check("query_recovery selected", kinds.includes("query_recovery"));
  check("large_write selected", kinds.includes("large_write"));
  check("deliverable_submit selected", kinds.includes("deliverable_submit"));

  const cb = moments.find((m) => m.kind === "curveball_response")!;
  check("curveball cites marker + next candidate message",
    JSON.stringify(cb.event_seqs) === JSON.stringify([4, 5]));
  check("curveball carries the candidate snippet",
    cb.candidate_text?.includes("duplicates") === true);

  const inj = moments.find((m) => m.kind === "injection_response")!;
  check("injection cites marker + next AI turn",
    JSON.stringify(inj.event_seqs) === JSON.stringify([6, 7]));

  const rec = moments.find((m) => m.kind === "query_recovery")!;
  check("recovery cites the error streak + fix",
    JSON.stringify(rec.event_seqs) === JSON.stringify([1, 2, 3]));

  check("empty stream → no moments", selectMoments([]).length === 0);
}

// ── [b] parse + grounding ────────────────────────────────────────────────────
{
  console.log("\n[b] parseQuestions");
  seq = 0;
  const moments = selectMoments([
    ev("curveball.fired", { beat_id: "b" }),
    ev("message.client.candidate", { text: "reply" }),
    ev("deliverable.submit", {}),
  ]);
  const good = JSON.stringify({
    questions: [
      { question: "Walk me through how you handled the mid-session requirement change.", moment_index: 0, rationale: "probes the curveball" },
      { question: "Why did you structure the final deliverable the way you did?", moment_index: 1, rationale: "probes the submit" },
      { question: "This one cites a moment that does not exist at all, hallucinated.", moment_index: 9, rationale: "hallucinated" },
    ],
  });
  const parsed = parseQuestions(good, moments);
  check("valid questions kept", parsed.length === 2, `kept=${parsed.length}`);
  check("hallucinated moment_index dropped", !parsed.some((q) => q.rationale === "hallucinated"));
  check("event seqs grounded from the moment",
    JSON.stringify(parsed[0]!.event_seqs) === JSON.stringify(moments[0]!.event_seqs));

  let threw = false;
  try { parseQuestions("not json", moments); } catch { threw = true; }
  check("non-JSON throws", threw);

  threw = false;
  try {
    parseQuestions(
      JSON.stringify({ questions: [{ question: "All of these cite hallucinated moments entirely.", moment_index: 7, rationale: "x" }] }),
      moments,
    );
  } catch { threw = true; }
  check("all-hallucinated output throws", threw);
}

console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
