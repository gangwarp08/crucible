// Slice 5.1 acceptance — canonical competency model + lossless rubric rebind.
//
// Proves two things against the live Supabase data (no server/LLM needed):
//
//   A. LOSSLESS REBIND. Resolving each scenario's rubric BINDING against the
//      canonical model reproduces the pre-rebind rubric byte-for-byte (compared
//      to the committed golden snapshot fixtures/competency-model/golden-pre-
//      rebind.json). The resolver here is an INDEPENDENT reimplementation of
//      services/competencies.ts#resolveBinding — two implementations agreeing
//      is a stronger check than the server validating its own output.
//
//   B. WEIGHTING UNCHANGED. Re-feeding every stored evaluation's items through
//      Σ(score·weight) reproduces the persisted overall_score (±0.005). This
//      isolates the rebind from the server-side arithmetic — without re-running
//      any session or LLM call.
//
// Run: pnpm exec tsx apps/server/scripts/verify-competency-model.ts
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync } from "fs";
import { WebSocket } from "undici";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
loadEnv({ path: resolve(repoRoot, ".env") });

const url =
  process.env.SUPABASE_URL ??
  (process.env.SUPABASE_PROJECT_REF
    ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co`
    : null);
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL/PROJECT_REF or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: WebSocket as any },
});

const SCENARIO_SLUGS = ["fde-db-triage", "fde-db-triage-pro"];

// Stable canonical JSON (sorted keys) so object key order never causes a false
// mismatch in the deep-equality comparison.
function canon(x: unknown): string {
  return JSON.stringify(x, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

interface BindingEntry {
  competency_key: string;
  weight: number;
  scenario_anchors?: Record<string, string>;
  scenario_description?: string;
  scenario_signals?: string[];
  scenario_scoring_note?: string;
}
interface CanonicalRow {
  key: string;
  definition: string;
  default_signals: string[] | null;
  default_anchors: Record<string, string> | null;
  default_scoring_note: string | null;
}
interface RubricItem {
  weight: number;
  description: string;
  signals: string[];
  anchors: Record<string, string>;
  scoring_note?: string;
}

// Independent reimplementation of services/competencies.ts#resolveBinding.
function resolveBinding(binding: BindingEntry[], model: Map<string, CanonicalRow>): Record<string, RubricItem> {
  const out: Record<string, RubricItem> = {};
  for (const e of binding) {
    const c = model.get(e.competency_key);
    if (!c) throw new Error(`binding references unknown competency '${e.competency_key}'`);
    const item: RubricItem = {
      weight: e.weight,
      description: e.scenario_description ?? c.definition,
      signals: e.scenario_signals ?? c.default_signals ?? [],
      anchors: e.scenario_anchors ?? c.default_anchors ?? {},
    };
    const note = e.scenario_scoring_note ?? c.default_scoring_note ?? undefined;
    if (note) item.scoring_note = note;
    out[e.competency_key] = item;
  }
  return out;
}

// Compare a resolved rubric to a golden one on exactly the fields the LLM sees.
function rubricMatches(resolved: Record<string, RubricItem>, golden: Record<string, RubricItem>): string[] {
  const diffs: string[] = [];
  const keys = new Set([...Object.keys(resolved), ...Object.keys(golden)]);
  for (const k of keys) {
    const r = resolved[k];
    const g = golden[k];
    if (!r) { diffs.push(`${k}: missing in resolved`); continue; }
    if (!g) { diffs.push(`${k}: missing in golden`); continue; }
    for (const f of ["weight", "description", "signals", "anchors", "scoring_note"] as const) {
      if (canon(r[f]) !== canon(g[f])) diffs.push(`${k}.${f} differs`);
    }
  }
  return diffs;
}

let failures = 0;
const fail = (m: string) => { console.log(`  ✗ ${m}`); failures++; };
const pass = (m: string) => console.log(`  ✓ ${m}`);

(async () => {
  // ── Load the active competency model ─────────────────────────────────────
  const { data: verRow, error: verErr } = await supabase
    .from("competency_model_versions")
    .select("version")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (verErr || !verRow) {
    console.error("FATAL: no competency_model_versions row — apply migrations 0007/0008");
    process.exit(2);
  }
  const version = (verRow as { version: number }).version;
  console.log(`Active competency model: v${version}\n`);

  const { data: compRows, error: compErr } = await supabase
    .from("competencies")
    .select("key, definition, default_signals, default_anchors, default_scoring_note")
    .eq("model_version", version);
  if (compErr || !compRows || compRows.length === 0) {
    console.error("FATAL: competency model has no rows");
    process.exit(2);
  }
  const model = new Map<string, CanonicalRow>();
  for (const r of compRows as CanonicalRow[]) model.set(r.key, r);
  console.log(`Loaded ${model.size} canonical competencies.\n`);

  // ── A. Lossless rebind vs golden snapshot ────────────────────────────────
  console.log("A. Lossless rebind (resolved binding == pre-rebind rubric)");
  const golden = JSON.parse(
    readFileSync(resolve(repoRoot, "fixtures/competency-model/golden-pre-rebind.json"), "utf8"),
  ) as Record<string, Record<string, RubricItem>>;

  for (const slug of SCENARIO_SLUGS) {
    const { data: scen, error } = await supabase
      .from("scenarios").select("rubric").eq("slug", slug).maybeSingle();
    if (error || !scen) { fail(`${slug}: scenario row not found`); continue; }
    const binding = (scen as { rubric: unknown }).rubric;
    if (!Array.isArray(binding)) {
      fail(`${slug}: rubric is not a binding array (rebind not applied?)`);
      continue;
    }
    let resolved: Record<string, RubricItem>;
    try {
      resolved = resolveBinding(binding as BindingEntry[], model);
    } catch (e) {
      fail(`${slug}: ${(e as Error).message}`);
      continue;
    }
    const diffs = rubricMatches(resolved, golden[slug] ?? {});
    if (diffs.length === 0) pass(`${slug}: resolves byte-identical to pre-rebind rubric (${Object.keys(resolved).length} competencies)`);
    else { fail(`${slug}: ${diffs.length} difference(s):`); diffs.forEach((d) => console.log(`      - ${d}`)); }
  }

  // ── B. Weighting unchanged across stored evaluations ─────────────────────
  console.log("\nB. Server-side weighting reproduces stored overall_score");
  const { data: evals } = await supabase
    .from("evaluations")
    .select("id, overall_score, status")
    .eq("status", "complete");
  const evalRows = (evals ?? []) as Array<{ id: string; overall_score: number | string; status: string }>;
  if (evalRows.length === 0) {
    console.log("  ⚠ no completed evaluations stored yet — weighting check SKIPPED");
  } else {
    let checked = 0;
    for (const ev of evalRows) {
      const { data: items } = await supabase
        .from("evaluation_items").select("score, weight").eq("evaluation_id", ev.id);
      const rows = (items ?? []) as Array<{ score: number | string; weight: number | string }>;
      if (rows.length === 0) continue;
      const recomputed = Math.round(
        rows.reduce((s, it) => s + Number(it.score) * Number(it.weight), 0) * 100,
      ) / 100;
      const persisted = Number(ev.overall_score);
      checked++;
      if (Math.abs(recomputed - persisted) >= 0.005) {
        fail(`eval ${ev.id.slice(0, 8)}: recomputed ${recomputed} ≠ persisted ${persisted}`);
      }
    }
    if (checked > 0 && failures === 0) pass(`${checked} evaluation(s): Σ(score·weight) matches persisted overall within ±0.005`);
    else if (checked > 0) console.log(`  (checked ${checked} evaluation(s))`);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(failures === 0 ? "PASS — competency model rebind is lossless" : `FAIL — ${failures} problem(s)`);
  process.exit(failures === 0 ? 0 : 1);
})();
