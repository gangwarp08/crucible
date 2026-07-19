import { appendFileSync } from "node:fs";

let logPath = null;

export function initLog(path) {
  logPath = path;
}

/** Structured-ish send log: one line per attempt outcome. The on-call runbook
 *  greps this file, so keep the key=value shape stable. */
export function logLine(fields) {
  const line = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  if (logPath) appendFileSync(logPath, line + "\n", "utf8");
}
