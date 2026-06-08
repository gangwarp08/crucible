// Per-query SQL invoker.
//
// Shells `python3 /tmp/crucible/sql_runner.py` inside the candidate's sandbox,
// passing the SQL via the CRUCIBLE_SQL env var so it never touches the shell
// command line. The runner script (uploaded once at session-provision time by
// services/dataset-seed.ts) opens /workspace/customer.db read-only and prints
// a single JSON document to stdout. We parse and return that.
//
// SQL errors are NOT exceptions in our system — they are data the candidate
// must see. The only paths that throw here are infrastructure failures
// (sandbox unreachable, runner script missing, JSON unparseable). Callers
// translate those into 5xx; SQL errors get HTTP 200 with { status: 'error' }.

import type { Sandbox } from "e2b";

const RUNNER_PATH = "/tmp/crucible/sql_runner.py";
const RUN_TIMEOUT_MS = 15_000;

export type QueryOk = {
  status: "ok";
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  durationMs: number;
  truncated: boolean;
};

export type QueryError = {
  status: "error";
  error: string;
  durationMs: number;
};

export type QueryResult = QueryOk | QueryError;

interface RunnerJsonOk {
  status: "ok";
  columns: string[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  duration_ms: number;
}

interface RunnerJsonError {
  status: "error";
  error: string;
  duration_ms: number;
}

type RunnerJson = RunnerJsonOk | RunnerJsonError;

export async function runSqliteQuery(
  sandbox: Sandbox,
  sql: string,
): Promise<QueryResult> {
  const t0 = Date.now();
  const exec = await sandbox.commands.run(`python3 ${RUNNER_PATH}`, {
    envs: { CRUCIBLE_SQL: sql },
    timeoutMs: RUN_TIMEOUT_MS,
  });

  const wallMs = Date.now() - t0;

  if (exec.exitCode !== 0) {
    // Runner crashed (missing DB, missing script, Python error inside the
    // try/except wrapping itself). Surface stderr to the candidate — it's
    // their workspace, they should see what went wrong.
    return {
      status: "error",
      error: `runner exit=${exec.exitCode}: ${exec.stderr.trim() || exec.stdout.trim() || "no output"}`,
      durationMs: wallMs,
    };
  }

  let parsed: RunnerJson;
  try {
    parsed = JSON.parse(exec.stdout) as RunnerJson;
  } catch (err) {
    return {
      status: "error",
      error: `runner returned non-JSON stdout (${(err as Error).message}): ${exec.stdout.slice(0, 200)}`,
      durationMs: wallMs,
    };
  }

  if (parsed.status === "ok") {
    return {
      status: "ok",
      columns: parsed.columns,
      rows: parsed.rows,
      rowCount: parsed.row_count,
      truncated: parsed.truncated,
      durationMs: parsed.duration_ms,
    };
  }

  return {
    status: "error",
    error: parsed.error,
    durationMs: parsed.duration_ms,
  };
}
