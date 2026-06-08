// One-off verifier for migration 0003: confirms the seed scenario and reads
// back a freshly-created session row to prove scenario_id + scenario_state are
// being persisted by the POST /sessions path. Not part of the production
// surface — kept here so future schema slices can reuse the pattern.
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { WebSocket } from "undici";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

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

const sessionId = process.argv[2]; // optional — read a specific session row

(async () => {
  const { data: scenario, error: scenErr } = await supabase
    .from("scenarios")
    .select("id, slug, title, difficulty, constraints, rubric")
    .eq("slug", "fde-db-triage")
    .single();
  if (scenErr) {
    console.error("scenario read failed:", scenErr.message);
    process.exit(1);
  }

  const rubricKeys = Object.keys(scenario.rubric as Record<string, unknown>).sort();
  console.log("=== SEED SCENARIO ===");
  console.log("id:         ", scenario.id);
  console.log("slug:       ", scenario.slug);
  console.log("title:      ", scenario.title);
  console.log("difficulty: ", scenario.difficulty);
  console.log("constraints:", JSON.stringify(scenario.constraints));
  console.log("rubric keys (n=" + rubricKeys.length + "):", rubricKeys);

  const EXPECTED = [
    "ai_orchestration",
    "customer_engagement",
    "data_fluency",
    "design_under_constraints",
    "execution",
    "outcome_communication",
    "problem_framing",
    "teamwork",
  ];
  const matches = JSON.stringify(rubricKeys) === JSON.stringify(EXPECTED);
  console.log("rubric matches 8-competency spec:", matches ? "YES" : "NO");
  if (!matches) {
    console.log("  expected:", EXPECTED);
    process.exit(1);
  }

  if (sessionId) {
    const { data: sess, error: sessErr } = await supabase
      .from("sessions")
      .select("id, scenario_id, scenario_state, sandbox_id, status, created_at")
      .eq("id", sessionId)
      .single();
    if (sessErr) {
      console.error("\nsession read failed:", sessErr.message);
      process.exit(1);
    }
    console.log("\n=== SESSION ROW ===");
    console.log(JSON.stringify(sess, null, 2));
  }

  console.log("\nOK");
})();
