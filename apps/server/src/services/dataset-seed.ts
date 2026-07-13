// Seed a scenario's synthetic dataset into the candidate's E2B sandbox.
//
// Invoked from createSandbox() once per session when scenario.dataset_ref is
// set. Builds /workspace/customer.db from the committed fixture files
// (schema.sql + seed.sql under fixtures/<dataset_ref>/) using Python's stdlib
// sqlite3 — no pip installs, no sqlite3 CLI dependency. The resulting DB is
// chmod 444 so even a candidate process opening it without mode=ro can't
// mutate it; the canonical read path (services/query-runner.ts) uses the URI
// ?mode=ro switch too — belt and suspenders.
//
// Staging files live under /tmp/crucible/ inside the sandbox (not /workspace),
// so they don't show up in the candidate's file tree.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sandbox } from "e2b";
import { SQL_RUNNER_PY, BUILD_DB_PY } from "./sqlrun.py.js";

const here = dirname(fileURLToPath(import.meta.url));
// From apps/server/src/services/ → repo root is 4 levels up. Works under
// `tsx watch` from a source checkout. If the server ever ships as a packaged
// dist/ without the fixtures dir colocated, this resolver will need to honour
// a CRUCIBLE_REPO_ROOT env var — not needed for the dev flow today.
const REPO_ROOT = resolve(here, "../../../..");

const STAGING_DIR = "/tmp/crucible";
const RUNNER_PATH = `${STAGING_DIR}/sql_runner.py`;
const BUILDER_PATH = `${STAGING_DIR}/build_db.py`;
const SCHEMA_PATH = `${STAGING_DIR}/schema.sql`;
const SEED_PATH = `${STAGING_DIR}/seed.sql`;
const DB_PATH = "/workspace/customer.db";

/** A scenario's dataset fixtures aren't present on the server's disk — the
 *  scenario can't be provisioned. Surfaced as a 422 by the start route. */
export class DatasetUnavailableError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "DatasetUnavailableError";
  }
}

export async function seedScenarioDataset(
  sandbox: Sandbox,
  datasetRef: string,
): Promise<void> {
  const fixtureDir = resolve(REPO_ROOT, datasetRef);

  // Read fixture files from local disk on the server, fail fast if missing.
  let schemaSql: string;
  let seedSql: string;
  try {
    schemaSql = readFileSync(resolve(fixtureDir, "schema.sql"), "utf8");
    seedSql = readFileSync(resolve(fixtureDir, "seed.sql"), "utf8");
  } catch (err) {
    // Missing fixture files on the server's disk (e.g. a scenario row whose
    // dataset_ref hasn't been deployed). Typed so the route can return a clean
    // 4xx instead of a raw 500.
    throw new DatasetUnavailableError(
      `[dataset-seed] fixture read failed for dataset_ref="${datasetRef}" ` +
        `at ${fixtureDir}: ${(err as Error).message}`,
    );
  }

  // The E2B template bakes a legacy Express sample app into /workspace
  // (index.js, package.json, node_modules) whose comments annotate its planted
  // bugs — under-the-hood text no candidate may see. No live scenario uses the
  // app, so clear it before seeding: the file tree then shows only the
  // scenario's dataset. Hard-fail like every other provisioning step — a
  // workspace with spoiler text is an invalid assessment environment.
  const wipe = await sandbox.commands.run(
    "rm -rf /workspace/index.js /workspace/package.json /workspace/package-lock.json /workspace/node_modules",
    { timeoutMs: 15_000 },
  );
  if (wipe.exitCode !== 0) {
    throw new Error(`[dataset-seed] workspace cleanup failed: ${wipe.stderr}`);
  }

  // Stage everything inside the sandbox in one logical batch.
  const mkdir = await sandbox.commands.run(`mkdir -p ${STAGING_DIR}`, {
    timeoutMs: 5_000,
  });
  if (mkdir.exitCode !== 0) {
    throw new Error(`[dataset-seed] mkdir failed: ${mkdir.stderr}`);
  }

  await sandbox.files.write(SCHEMA_PATH, schemaSql);
  await sandbox.files.write(SEED_PATH, seedSql);
  await sandbox.files.write(RUNNER_PATH, SQL_RUNNER_PY);
  await sandbox.files.write(BUILDER_PATH, BUILD_DB_PY);

  // Build the SQLite DB inside the sandbox. The builder script also runs row-
  // count sanity checks and prints a single "built ok {…}" line to stdout.
  const build = await sandbox.commands.run(`python3 ${BUILDER_PATH}`, {
    timeoutMs: 30_000,
  });
  if (build.exitCode !== 0) {
    throw new Error(
      `[dataset-seed] build_db.py exit=${build.exitCode}\n` +
        `stderr: ${build.stderr}\nstdout: ${build.stdout}`,
    );
  }

  // Defense-in-depth: make the DB file unwritable by the candidate process.
  // The runner already uses ?mode=ro at connect-time; this is a second layer.
  const chmod = await sandbox.commands.run(`chmod 444 ${DB_PATH}`, {
    timeoutMs: 5_000,
  });
  if (chmod.exitCode !== 0) {
    throw new Error(`[dataset-seed] chmod 444 ${DB_PATH} failed: ${chmod.stderr}`);
  }

  // Remove the raw seed staging copies now the DB is built: schema.sql +
  // seed.sql (the row-dump bypass the security audit flagged) and the one-shot
  // builder. CRITICAL: keep RUNNER_PATH (sql_runner.py) — runSqliteQuery shells
  // `python3 /tmp/crucible/sql_runner.py` on EVERY query, so deleting it breaks
  // all candidate SQL. (The original audit fix rm -rf'd the whole STAGING_DIR,
  // which took the runner with it — a live-query regression; scope the delete
  // to the seed files only.) Best-effort — cleanup failure must not fail
  // provisioning.
  await sandbox.commands
    .run(`rm -f ${SCHEMA_PATH} ${SEED_PATH} ${BUILDER_PATH}`, { timeoutMs: 5_000 })
    .catch(() => { /* best-effort; DB is already built + locked */ });

  console.log(
    `[dataset-seed] dataset_ref="${datasetRef}" → ${DB_PATH} :: ${build.stdout.trim()}`,
  );
}
