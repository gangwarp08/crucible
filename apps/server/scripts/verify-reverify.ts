/**
 * verify-reverify.ts — slice V10 acceptance (infra-light subset).
 *
 * The reverify flow is mostly DB plumbing (link mint → short-clock session →
 * anchor compare) covered by the live E2E pass; this script pins the pure
 * pieces: the org-flag read, the env default, and the fact that the comparison
 * math is the SAME version-gated cosine used by continuity (already covered by
 * verify-face-continuity.ts — re-asserted here against the exported fns).
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-reverify.ts
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const { reverifyEnabledFromSettings, reverifyTimeoutMin } = await import(
  "../src/services/reverify.js"
);
const { cosineSimilarity } = await import("../src/services/face-continuity.js");

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

console.log("verify-reverify — slice V10\n");

check("flag: absent settings → false", reverifyEnabledFromSettings(null) === false);
check("flag: empty settings → false", reverifyEnabledFromSettings({}) === false);
check("flag: truthy-but-not-true → false", reverifyEnabledFromSettings({ posthire_reverify_enabled: "true" }) === false);
check("flag: literal true → true", reverifyEnabledFromSettings({ posthire_reverify_enabled: true }) === true);

check("env: REVERIFY_TIMEOUT_MIN defaults positive", reverifyTimeoutMin() > 0, String(reverifyTimeoutMin()));

// Same-person comparison math = the continuity cosine (version gating happens
// in recordReverifyComparison before this is called).
check("comparison math: identical anchors → 1",
  Math.abs((cosineSimilarity([0.1, 0.5, -0.2], [0.1, 0.5, -0.2]) ?? 0) - 1) < 1e-9);
check("comparison math: different person ≪ 1",
  (cosineSimilarity([1, 0, 0, 0], [0, 1, 0, 0]) ?? 1) < 0.01);

console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
