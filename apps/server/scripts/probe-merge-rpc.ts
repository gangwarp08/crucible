// One-off probe to verify the merge_scenario_state RPC is callable + behaves correctly.
// After confirming, this file can stay as a tiny smoke-test for future migrations.
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { WebSocket } from "undici";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const supabase = createClient(
  process.env.SUPABASE_URL ?? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co`,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    realtime: { transport: WebSocket as any } },
);

const { data: sess } = await supabase.from("sessions")
  .select("id, scenario_state").order("created_at", { ascending: false }).limit(1).single();
if (!sess) { console.error("no session rows to probe against"); process.exit(1); }
const id = (sess as { id: string }).id;
const before = ((sess as { scenario_state: Record<string, unknown> }).scenario_state ?? {});
console.log(`probing on session ${id}`);
console.log(`  keys before: [${Object.keys(before).sort().join(", ")}]`);

const { error } = await supabase.rpc("merge_scenario_state", {
  p_session_id: id,
  p_patch: { __probe: { v: 42, ts: new Date().toISOString() } },
});
if (error) { console.error("RPC failed:", error.message); process.exit(1); }
console.log("  RPC returned no error");

const { data: after } = await supabase.from("sessions")
  .select("scenario_state").eq("id", id).single();
const afterState = ((after as { scenario_state: Record<string, unknown> }).scenario_state ?? {});
console.log(`  keys after:  [${Object.keys(afterState).sort().join(", ")}]`);
console.log(`  __probe:     ${JSON.stringify(afterState["__probe"])}`);

const lost: string[] = [];
for (const k of Object.keys(before)) {
  if (k === "__probe") continue;
  if (JSON.stringify(afterState[k]) !== JSON.stringify(before[k])) lost.push(k);
}
console.log(`  preserved:   ${lost.length === 0 ? "YES (all " + Object.keys(before).length + " original keys intact)" : "NO — lost/changed: " + lost.join(", ")}`);

console.log(lost.length === 0 ? "\nPROBE PASSED" : "\nPROBE FAILED");
process.exit(lost.length === 0 ? 0 : 1);
