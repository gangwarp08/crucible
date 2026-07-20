// Family-3 (fde-code-debug) END-TO-END provisioning smoke — REAL E2B.
//
// Exercises the git_repo dataset path against a live sandbox, exactly as
// createSandbox() would: create from the crucible-dev template (egress
// denied), seed via seedScenarioDataset (manifest dispatch → repo extract +
// git init), write the guarded workspace README, then assert the candidate's
// actual working conditions:
//
//   [A] workspace shape — repo landed, legacy sample app wiped, README present
//   [B] toolchain — node runs the committed suite green inside the sandbox
//   [C] the bug is live — the batch sends every delivery (sent=2266 deduped=0)
//   [D] the scenario is solvable — applying the intended one-line fix inside
//       the sandbox dedupes exactly the ground-truth duplicate count
//   [E] git — the tree is a committed repo (candidate can `git diff`);
//       non-fatal by design, so this only warns if git was unavailable
//
// Costs one short-lived sandbox (~2 min, killed on exit either way).
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-family3-e2e.ts
import { config as loadEnv } from "dotenv";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { Sandbox } from "e2b";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
loadEnv({ path: resolve(repoRoot, ".env") });

const { seedScenarioDataset } = await import("../src/services/dataset-seed.js");
const { renderGuardedReadme } = await import("../src/services/workspace-readme.js");

const DATASET_REF = "fixtures/fde-code-debug";
const WORK = "/workspace/vantage-notify";

const gt = JSON.parse(
  readFileSync(resolve(repoRoot, DATASET_REF, "ground_truth.json"), "utf8"),
) as Record<string, number>;
const scenarioDoc = JSON.parse(
  readFileSync(resolve(repoRoot, DATASET_REF, "scenario.json"), "utf8"),
) as Record<string, unknown>;

let failures = 0;
function assert(cond: boolean, label: string, detail = ""): void {
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("[e2e] creating sandbox from crucible-dev (egress denied)…");
const sandbox = await Sandbox.create("crucible-dev", {
  timeoutMs: 5 * 60_000,
  metadata: { purpose: "verify-family3-e2e" },
  allowInternetAccess: false,
});

try {
  console.log(`[e2e] sandbox ${sandbox.sandboxId} — seeding ${DATASET_REF}…`);
  await seedScenarioDataset(sandbox, DATASET_REF);

  // README exactly as createSandbox writes it (guarded render).
  const readme = renderGuardedReadme(
    { ...scenarioDoc, id: "e2e", created_at: "e2e" } as never,
    [],
  );
  await sandbox.files.write("/workspace/README.md", readme);

  console.log("[A] workspace shape");
  const shape = await sandbox.commands.run(
    `ls ${WORK}/package.json ${WORK}/src/lib/keys.js ${WORK}/data/events.jsonl /workspace/README.md 2>&1; ` +
      `test ! -e /workspace/index.js && echo LEGACY_WIPED`,
    { timeoutMs: 10_000 },
  );
  assert(shape.stdout.includes("package.json"), "repo tree extracted", shape.stdout);
  assert(shape.stdout.includes("LEGACY_WIPED"), "legacy sample app wiped");

  console.log("[B] toolchain — committed suite runs green in-sandbox");
  // Glob form, not `node --test test/`: the template's Node 24 no longer
  // auto-scans an explicit directory argument (works on 18, breaks on 24).
  const tests = await sandbox.commands.run(
    `cd ${WORK} && node --test test/*.test.js 2>&1 | tail -8`,
    { timeoutMs: 60_000 },
  );
  // Reporter format differs by Node major (TAP `# pass 18` vs spec `ℹ pass 18`).
  assert(/(#|ℹ)\s*pass 18\b/.test(tests.stdout) && /(#|ℹ)\s*fail 0\b/.test(tests.stdout),
    "node --test → 18 pass / 0 fail", tests.stdout.slice(-200));

  console.log("[C] the bug is live");
  const buggy = await sandbox.commands.run(
    `cd ${WORK} && rm -f data/outbox.jsonl data/send.log && node src/cli.js data/events.jsonl`,
    { timeoutMs: 60_000 },
  );
  assert(
    buggy.stdout.includes(`deliveries=${gt.total_deliveries} sent=${gt.total_deliveries} deduped=0`),
    `buggy batch sends every delivery (sent=${gt.total_deliveries}, deduped=0)`,
    buggy.stdout.trim(),
  );

  console.log("[D] the scenario is solvable — intended fix dedupes ground truth");
  const fixed = await sandbox.commands.run(
    `cd ${WORK} && sed -i 's/delivery.delivery_id/delivery.event.id/' src/lib/keys.js && ` +
      `rm -f data/outbox.jsonl data/send.log && node src/cli.js data/events.jsonl`,
    { timeoutMs: 60_000 },
  );
  assert(
    fixed.stdout.includes(`sent=${gt.total_events} deduped=${gt.duplicate_notification_count}`),
    `fixed batch dedupes exactly ${gt.duplicate_notification_count}`,
    fixed.stdout.trim(),
  );

  console.log("[E] git (best-effort by design)");
  const git = await sandbox.commands.run(
    `cd ${WORK} && git log --oneline -1 && git status --porcelain | head -2`,
    { timeoutMs: 10_000 },
  );
  if (git.exitCode === 0) {
    assert(git.stdout.includes("import vantage-notify"), "git repo committed; diffable");
  } else {
    console.warn("  warn git unavailable in template (seeding treats as non-fatal):", git.stderr.trim());
  }
} finally {
  await sandbox.kill().catch(() => {});
  console.log("[e2e] sandbox killed");
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nOK — full E2B provisioning path verified");
