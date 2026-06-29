// Authoring path for the canonical competency model (Slice 5.1).
//
// Reads fixtures/competency-model/v1.json and upserts the model-version row plus
// its competency rows via the service-role client. Mirrors the encode-fde-*
// pattern: the committed migration 0008_scenario_rubric_rebind.sql carries the
// same seed so `supabase db reset` reproduces the live state; this script is the
// apply path for environments without the Supabase CLI, and the place to
// re-apply after editing the fixture.
//
// Run: pnpm exec tsx apps/server/scripts/encode-competency-model.ts
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

interface ModelDoc {
  version: number;
  note?: string;
  competencies: Array<{
    key: string;
    name: string;
    construct_family: string;
    definition: string;
    default_signals?: string[];
    default_anchors?: Record<string, string>;
    default_scoring_note?: string | null;
    dimensions?: unknown[];
  }>;
}

(async () => {
  const docPath = resolve(repoRoot, "fixtures/competency-model/v1.json");
  const doc = JSON.parse(readFileSync(docPath, "utf8")) as ModelDoc;

  if (!Number.isInteger(doc.version) || doc.version < 1) {
    console.error(`invalid model version: ${doc.version}`);
    process.exit(1);
  }
  if (!Array.isArray(doc.competencies) || doc.competencies.length === 0) {
    console.error("no competencies in fixture");
    process.exit(1);
  }

  console.log(`=== competency model v${doc.version} (${doc.competencies.length} competencies) ===`);

  const { error: verErr } = await supabase
    .from("competency_model_versions")
    .upsert({ version: doc.version, note: doc.note ?? null }, { onConflict: "version" });
  if (verErr) {
    console.error("model-version upsert failed:", verErr.message);
    process.exit(1);
  }

  const rows = doc.competencies.map((c) => ({
    key: c.key,
    name: c.name,
    construct_family: c.construct_family,
    definition: c.definition,
    default_signals: c.default_signals ?? [],
    default_anchors: c.default_anchors ?? {},
    default_scoring_note: c.default_scoring_note ?? null,
    dimensions: c.dimensions ?? [],
    model_version: doc.version,
  }));
  const { error: compErr } = await supabase
    .from("competencies")
    .upsert(rows, { onConflict: "key,model_version" });
  if (compErr) {
    console.error("competencies upsert failed:", compErr.message);
    process.exit(1);
  }

  for (const c of doc.competencies) {
    console.log(`  ✓ ${c.key.padEnd(26)} [${c.construct_family}]`);
  }
  console.log("done.");
})();
