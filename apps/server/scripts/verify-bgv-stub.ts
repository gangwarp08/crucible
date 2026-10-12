/**
 * verify-bgv-stub.ts — slice V9 acceptance.
 *
 * Deterministic, infra-light: exercises the stub provider + the pure result
 * helpers and the bgv component of the verification-confidence score. The
 * DB/webhook legs are covered by the live E2E pass.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-bgv-stub.ts
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const { stubBgvProvider, isClear } = await import("../src/services/bgv/index.js");
const { computeVerificationConfidence } = await import(
  "../src/services/verification-confidence.js"
);

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

console.log("verify-bgv-stub — slice V9\n");

// ── [a] stub determinism ─────────────────────────────────────────────────────
{
  console.log("[a] stub provider");
  const clear = await stubBgvProvider.requestCheck({
    candidateLabel: "cand-007",
    checks: ["employment", "education"],
  });
  check("inline results (synchronous)", clear.inlineResults !== null);
  check("clear label → all clear", isClear(clear.inlineResults) === true);
  check("stable external ref",
    clear.externalRef ===
      (await stubBgvProvider.requestCheck({ candidateLabel: "cand-007", checks: ["education", "employment"] })).externalRef);

  const disc = await stubBgvProvider.requestCheck({
    candidateLabel: "cand-discrepancy-01",
    checks: ["employment"],
  });
  check("discrepancy label → not clear", isClear(disc.inlineResults) === false);

  const unv = await stubBgvProvider.requestCheck({
    candidateLabel: "cand-unverifiable-01",
    checks: ["employment"],
  });
  check("unverifiable label → not clear", isClear(unv.inlineResults) === false);
  check("empty results → null", isClear({}) === null && isClear(null) === null);
}

// ── [b] webhook parsing ──────────────────────────────────────────────────────
{
  console.log("\n[b] parseWebhook");
  const parsed = stubBgvProvider.parseWebhook({
    external_ref: "stub-abc",
    results: { employment: { status: "clear", note: "ok" }, bogus: { status: "clear" } },
  });
  check("external ref parsed", parsed.externalRef === "stub-abc");
  check("known checks kept, unknown dropped",
    parsed.results.employment?.status === "clear" && !("bogus" in parsed.results));
  let threw = false;
  try { stubBgvProvider.parseWebhook("junk"); } catch { threw = true; }
  check("unparseable payload throws", threw);
}

// ── [c] confidence integration ───────────────────────────────────────────────
{
  console.log("\n[c] bgv component of verification confidence");
  const clear = computeVerificationConfidence([], { bgv: { status: "complete", clear: true } });
  const disc = computeVerificationConfidence([], { bgv: { status: "complete", clear: false } });
  const pending = computeVerificationConfidence([], { bgv: { status: "pending", clear: null } });
  const none = computeVerificationConfidence([], { bgv: null });
  const c = (r: typeof clear) => r.components.find((x) => x.kind === "bgv")!;
  check("complete+clear → full points, assessed", c(clear).status === "assessed" && c(clear).points === c(clear).max);
  check("complete+discrepancy → 0 points, assessed", c(disc).status === "assessed" && c(disc).points === 0);
  check("pending → not_assessed", c(pending).status === "not_assessed");
  check("absent → not_assessed", c(none).status === "not_assessed");
}

console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
