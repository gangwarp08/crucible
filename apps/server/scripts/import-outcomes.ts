// CSV outcome importer (Slice 5.5).
//
// Bulk-loads design-partner outcomes from a CSV into the outcomes table via the
// service role (no HTTP, no webhook secret). Each row is validated with the same
// Zod schema the webhook uses, so CSV and webhook ingestion can't diverge.
//
// CSV header (order-independent): candidate_ref, outcome_type, value,
//   session_id?, scenario_id?, captured_at?
//   - value: "true"/"false" for bool outcomes; a number otherwise.
//   - session_id/scenario_id/captured_at: leave blank to omit.
//
// Run: pnpm --filter @crucible/server exec tsx scripts/import-outcomes.ts <file.csv>
//
// dotenv MUST load before services/outcomes (→ services/supabase reads env at
// import time), so the service module is pulled in via dynamic import below.
import { config as loadEnv } from "dotenv";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const { OutcomeInputSchema, insertOutcome, OUTCOME_TYPES } = await import(
  "../src/services/outcomes.js"
);

const BOOL_TYPES = new Set(["hired", "retained_90d"]);

/** Minimal RFC-4180-ish CSV parser: handles double-quoted fields (incl. commas
 *  and escaped "" quotes) and CRLF. Adequate for partner outcome exports. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
    } else if (c === "\r") {
      // swallow; \n handles the row break
    } else field += c;
  }
  // trailing field/row (file without final newline)
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function coerceValue(outcomeType: string, raw: string): boolean | number {
  const t = raw.trim();
  if (BOOL_TYPES.has(outcomeType)) {
    if (/^(true|1|yes|y)$/i.test(t)) return true;
    if (/^(false|0|no|n)$/i.test(t)) return false;
    throw new Error(`expected boolean for ${outcomeType}, got "${raw}"`);
  }
  const n = Number(t);
  if (!Number.isFinite(n)) throw new Error(`expected number for ${outcomeType}, got "${raw}"`);
  return n;
}

(async () => {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: tsx scripts/import-outcomes.ts <file.csv>");
    process.exit(1);
  }
  const text = readFileSync(resolve(process.cwd(), file), "utf8");
  const rows = parseCsv(text);
  if (rows.length < 2) {
    console.error("CSV has no data rows");
    process.exit(1);
  }

  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const need = ["candidate_ref", "outcome_type", "value"];
  for (const col of need) {
    if (idx(col) === -1) {
      console.error(`CSV missing required column: ${col} (have: ${header.join(", ")})`);
      process.exit(1);
    }
  }
  console.log(`import-outcomes: ${rows.length - 1} data row(s); valid types: ${OUTCOME_TYPES.join(", ")}`);

  let ok = 0;
  let failed = 0;
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    const get = (name: string): string => (idx(name) >= 0 ? (cells[idx(name)] ?? "").trim() : "");
    const outcomeType = get("outcome_type");
    try {
      const input = {
        candidate_ref: get("candidate_ref"),
        outcome_type: outcomeType,
        value: coerceValue(outcomeType, get("value")),
        ...(get("session_id") ? { session_id: get("session_id") } : {}),
        ...(get("scenario_id") ? { scenario_id: get("scenario_id") } : {}),
        ...(get("captured_at") ? { captured_at: get("captured_at") } : {}),
      };
      const parsed = OutcomeInputSchema.safeParse(input);
      if (!parsed.success) {
        failed++;
        console.error(`  row ${r}: invalid — ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
        continue;
      }
      const out = await insertOutcome(parsed.data, "csv");
      ok++;
      console.log(`  row ${r}: ${out.outcome_type}=${JSON.stringify(out.outcome_value.value)} → ${out.id}`);
    } catch (err) {
      failed++;
      console.error(`  row ${r}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\nimported ${ok} outcome(s), ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
