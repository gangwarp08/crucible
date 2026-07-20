// Seed a scenario's synthetic dataset into the candidate's E2B sandbox.
//
// Invoked from createSandbox() once per session when scenario.dataset_ref is
// set. Two dataset KINDS, dispatched on the fixture's dataset.json manifest
// (absent manifest = "sqlite", so every pre-manifest fixture keeps working):
//
//   sqlite   — builds /workspace/customer.db from schema.sql + seed.sql using
//              Python's stdlib sqlite3, then chmod 444 (read-only data; the
//              canonical read path services/query-runner.ts also opens with
//              ?mode=ro — belt and suspenders).
//   git_repo — ships the committed tree under fixtures/<dataset_ref>/<root>/
//              into /workspace/<workspace_dir>/ (WRITABLE — the candidate's
//              job is to edit this code) and best-effort git-inits it so
//              `git diff` works in the terminal.
//
// Staging files live under /tmp/crucible/ inside the sandbox (not /workspace),
// so they don't show up in the candidate's file tree.

import { execFileSync } from "node:child_process";
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

export interface DatasetManifest {
  kind: "sqlite" | "git_repo";
  /** git_repo: directory under the fixture dir holding the tree to ship. */
  root: string;
  /** git_repo: directory name the tree lands under inside /workspace. */
  workspace_dir: string;
}

/** Read the fixture's dataset.json manifest. Absent file (or absent fields)
 *  falls back to the pre-manifest default: a sqlite dataset. An unknown kind
 *  is a hard authoring error — provisioning a scenario against a seeder that
 *  doesn't understand its dataset must fail loudly, not half-seed. */
export function readDatasetManifest(datasetRef: string): DatasetManifest {
  const fallback: DatasetManifest = { kind: "sqlite", root: ".", workspace_dir: "" };
  let raw: string;
  try {
    raw = readFileSync(resolve(REPO_ROOT, datasetRef, "dataset.json"), "utf8");
  } catch {
    return fallback;
  }
  const parsed = JSON.parse(raw) as Partial<DatasetManifest>;
  const kind = parsed.kind ?? "sqlite";
  if (kind !== "sqlite" && kind !== "git_repo") {
    throw new DatasetUnavailableError(
      `[dataset-seed] dataset_ref="${datasetRef}" has unknown dataset.json kind "${String(kind)}"`,
    );
  }
  return {
    kind,
    root: parsed.root ?? ".",
    workspace_dir: parsed.workspace_dir ?? "workspace",
  };
}

/** Null-safe, never-throwing dataset-kind lookup for presentation/guard
 *  paths (scenarioMeta, the query-route SQL refusal). A malformed manifest
 *  must not break a HUD poll — provisioning is where it fails loudly. */
export function scenarioDatasetKind(
  datasetRef: string | null | undefined,
): DatasetManifest["kind"] | null {
  if (!datasetRef) return null;
  try {
    return readDatasetManifest(datasetRef).kind;
  } catch {
    return null;
  }
}

export async function seedScenarioDataset(
  sandbox: Sandbox,
  datasetRef: string,
): Promise<void> {
  const manifest = readDatasetManifest(datasetRef);
  if (manifest.kind === "git_repo") {
    await seedRepoDataset(sandbox, datasetRef, manifest);
    return;
  }
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

// ─── git_repo datasets ───────────────────────────────────────────────────────

/** Ship a committed fixture tree into the sandbox as the candidate's working
 *  repo. Transfer is one tar.gz, base64-armored through files.write (a plain
 *  text write — no binary-encoding ambiguity), extracted inside the sandbox.
 *  The tree stays WRITABLE: unlike the sqlite datasets, editing this code is
 *  the assessment. git init is best-effort — `git diff` is a nicety for the
 *  candidate, not a provisioning requirement, so a template without git must
 *  not fail the session. */
async function seedRepoDataset(
  sandbox: Sandbox,
  datasetRef: string,
  manifest: DatasetManifest,
): Promise<void> {
  const treeDir = resolve(REPO_ROOT, datasetRef, manifest.root);
  const workDir = `/workspace/${manifest.workspace_dir}`;
  const archiveB64Path = `${STAGING_DIR}/repo.tgz.b64`;

  let archiveB64: string;
  try {
    // -C treeDir . → paths inside the archive are relative to the tree root.
    const tgz = execFileSync("tar", ["-czf", "-", "-C", treeDir, "."], {
      maxBuffer: 64 * 1024 * 1024,
    });
    archiveB64 = tgz.toString("base64");
  } catch (err) {
    throw new DatasetUnavailableError(
      `[dataset-seed] repo archive failed for dataset_ref="${datasetRef}" ` +
        `at ${treeDir}: ${(err as Error).message}`,
    );
  }

  // Same legacy-sample cleanup as the sqlite path — the template's baked-in
  // Express app annotates its own planted bugs; no candidate may ever see it.
  const wipe = await sandbox.commands.run(
    "rm -rf /workspace/index.js /workspace/package.json /workspace/package-lock.json /workspace/node_modules",
    { timeoutMs: 15_000 },
  );
  if (wipe.exitCode !== 0) {
    throw new Error(`[dataset-seed] workspace cleanup failed: ${wipe.stderr}`);
  }

  const mkdir = await sandbox.commands.run(`mkdir -p ${STAGING_DIR} ${workDir}`, {
    timeoutMs: 5_000,
  });
  if (mkdir.exitCode !== 0) {
    throw new Error(`[dataset-seed] mkdir failed: ${mkdir.stderr}`);
  }

  await sandbox.files.write(archiveB64Path, archiveB64);

  const extract = await sandbox.commands.run(
    `base64 -d ${archiveB64Path} | tar -xz -C ${workDir}`,
    { timeoutMs: 30_000 },
  );
  if (extract.exitCode !== 0) {
    throw new Error(
      `[dataset-seed] repo extract failed exit=${extract.exitCode}\nstderr: ${extract.stderr}`,
    );
  }

  // Provisioning sanity check — an empty extraction is an invalid environment.
  const check = await sandbox.commands.run(`ls -A ${workDir} | head -1`, {
    timeoutMs: 5_000,
  });
  if (check.exitCode !== 0 || check.stdout.trim() === "") {
    throw new Error(`[dataset-seed] repo landed empty at ${workDir}`);
  }

  // Best-effort: make it a real git repo so the candidate can diff their work.
  const git = await sandbox.commands
    .run(
      `cd ${workDir} && git init -q -b main && git add -A && ` +
        `git -c user.email=platform@vantage.invalid -c user.name="Platform Import" ` +
        `commit -qm "import ${manifest.workspace_dir}"`,
      { timeoutMs: 30_000 },
    )
    .catch(() => null);
  if (!git || git.exitCode !== 0) {
    console.warn(
      `[dataset-seed] git init skipped for ${workDir} (git unavailable or failed) — non-fatal`,
    );
  }

  await sandbox.commands
    .run(`rm -f ${archiveB64Path}`, { timeoutMs: 5_000 })
    .catch(() => { /* best-effort; tree is already extracted */ });

  console.log(
    `[dataset-seed] dataset_ref="${datasetRef}" (git_repo) → ${workDir} :: git=${git && git.exitCode === 0 ? "ok" : "skipped"}`,
  );
}
