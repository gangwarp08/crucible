import { readFileSync, appendFileSync } from "node:fs";

/** Read a JSONL file into an array of parsed objects. Blank lines skipped. */
export function readJsonl(path) {
  const out = [];
  const raw = readFileSync(path, "utf8");
  let lineNo = 0;
  for (const line of raw.split("\n")) {
    lineNo += 1;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch (err) {
      throw new Error(`${path}:${lineNo} bad JSON: ${err.message}`);
    }
  }
  return out;
}

/** Append one object as a JSONL line. */
export function appendJsonl(path, obj) {
  appendFileSync(path, JSON.stringify(obj) + "\n", "utf8");
}
