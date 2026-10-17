/**
 * verify-face-continuity.ts — verification continuity (slice V4) acceptance.
 *
 * Deterministic, infra-light: exercises the pure math + streak core in
 * src/services/face-continuity.ts. The Supabase-touching paths (storeAnchor /
 * readAnchor / recordContinuitySample) are dormancy-gated on migration 0027
 * and covered by the live E2E pass, not here.
 *
 * Acceptance:
 *   - cosineSimilarity: identical vectors → 1; orthogonal → 0; opposite → -1;
 *     dimension mismatch / zero vectors / non-finite members → null;
 *   - mismatch streak: MISMATCH_CONSECUTIVE below-threshold samples → fires
 *     exactly once; recovery re-arms; a single dip never fires;
 *   - threshold boundary: similarity exactly AT the threshold counts as a
 *     match (>=), not a mismatch.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-face-continuity.ts
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

// Repo-root .env BEFORE the service import — face-continuity.ts reads env.ts
// (FACE_MATCH_THRESHOLD), which hard-exits on missing required vars.
const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const {
  cosineSimilarity,
  newMismatchState,
  observeSimilarity,
  MISMATCH_CONSECUTIVE,
} = await import("../src/services/face-continuity.js");

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

console.log("verify-face-continuity — verification slice (V4)");
console.log(`mismatch streak: ${MISMATCH_CONSECUTIVE} consecutive\n`);

// ── [a] cosine similarity ────────────────────────────────────────────────────
{
  console.log("[a] cosine similarity");
  const a = [1, 2, 3, 4];
  check("identical → 1", Math.abs((cosineSimilarity(a, a) ?? 0) - 1) < 1e-9);
  check("orthogonal → 0", Math.abs(cosineSimilarity([1, 0], [0, 1]) ?? 1) < 1e-9);
  check("opposite → -1", Math.abs((cosineSimilarity([1, 2], [-1, -2]) ?? 0) + 1) < 1e-9);
  check("dimension mismatch → null", cosineSimilarity([1, 2, 3], [1, 2]) === null);
  check("zero vector → null", cosineSimilarity([0, 0, 0], [1, 2, 3]) === null);
  check("non-finite member → null", cosineSimilarity([1, NaN], [1, 2]) === null);
  check("empty → null", cosineSimilarity([], []) === null);
}

// ── [b] mismatch streak ──────────────────────────────────────────────────────
const THRESHOLD = 0.32;
function run(sims: number[]): number[] {
  const state = newMismatchState();
  const fires: number[] = [];
  sims.forEach((s, i) => {
    if (observeSimilarity(state, s, THRESHOLD)) fires.push(i);
  });
  return fires;
}
{
  console.log("\n[b] mismatch streak");
  check("steady match never fires", run([0.9, 0.8, 0.85, 0.9]).length === 0);
  check(
    "sustained mismatch fires exactly once",
    JSON.stringify(run([0.9, 0.1, 0.1, 0.1, 0.1])) === JSON.stringify([2]),
    `fires=${run([0.9, 0.1, 0.1, 0.1, 0.1]).join(",")}`,
  );
  check("single dip never fires", run([0.9, 0.1, 0.9, 0.9]).length === 0);
  check(
    "recovery re-arms (two swaps fire twice)",
    run([0.9, 0.1, 0.1, 0.9, 0.1, 0.1]).length === 2,
    `fires=${run([0.9, 0.1, 0.1, 0.9, 0.1, 0.1]).join(",")}`,
  );
  check("exactly AT threshold counts as match", run([THRESHOLD, THRESHOLD, THRESHOLD]).length === 0);
  check(
    "just below threshold counts toward streak",
    run([THRESHOLD - 0.01, THRESHOLD - 0.01]).length === 1,
  );
}

console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
