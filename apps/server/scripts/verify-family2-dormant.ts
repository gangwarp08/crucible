// verify-family2-dormant.ts — P3.5 acceptance (dormancy of the second family).
//
// Family 2 (fde-api-integration) is DORMANT BY CONSTRUCTION: migration 0023
// seeds every member with catalog_visible = false, so it is never listable in
// the candidate catalog and never assignable to pilot candidates. This script
// proves the dormancy holds AND that the two sanctioned internal paths stay
// open for isolated calibration:
//
//   [a] every family-2 scenario row has catalog_visible = false
//   [b] listScenarios() (the catalog the browser sees via GET /api/scenarios)
//       returns NO family-2 slug — and family 1 still lists (catalog intact)
//   [c] direct load by slug (loadScenarioBySlug) still works — /start/<slug>
//       by explicit slug is the INTERNAL CALIBRATION PATH: it requires knowing
//       the slug (never discoverable via the catalog) and the invite code
//       where INVITE_CODE is set. Documented, deliberate, not an accident.
//   [d] session-link creation for the hidden scenario succeeds for the admin
//       org — admins may mint calibration links to a dormant scenario; the
//       catalog hiding is about candidates browsing/picking, not about the
//       operator's ability to calibrate.
//
// ── ACTIVATION SWITCH (deliberate, manual, documented — never automatic) ────
//
//   Trigger: "cohort 1 closed" = ALL cohort-1 session links are consumed or
//   expired AND every cohort-1 session has a complete evaluation. Confirm in
//   the review dashboard, then flip:
//
//     UPDATE scenarios SET catalog_visible = true
//     WHERE family_id = 'fde-api-integration';
//
//   Prerequisites before flipping: verify-family2-discrimination,
//   verify-family2-isomorph, verify-cross-family-scale and this script all
//   green (family 2 passed isolated calibration). Optionally enable band
//   routing to the family afterwards. See docs/ARCHITECTURE-REPORT.md §13.5.
//
// INFRA-LIGHT: Supabase reads + one session_links insert (cleaned up) — no
// server, no sandbox, no LLM. SKIPS (exit 0 + message) when env is missing or
// the 0023 seed is not applied.
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-family2-dormant.ts

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { FAMILY2 } from "./family2-content.js";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

let failures = 0;
const fail = (m: string): void => { failures++; console.error("  FAIL:", m); };
const pass = (m: string): void => console.log("  PASS:", m);
function skip(m: string): never { console.log(`⚠ SKIP — ${m}`); process.exit(0); }

(async () => {
  console.log("verify-family2-dormant — P3.5 (catalog-hidden + unassignable until the flip)");

  if (
    !process.env.SUPABASE_SERVICE_ROLE_KEY ||
    (!process.env.SUPABASE_URL && !process.env.SUPABASE_PROJECT_REF)
  ) skip("SUPABASE_URL/PROJECT_REF or SUPABASE_SERVICE_ROLE_KEY not set");

  // Dynamic imports AFTER dotenv so services/supabase.js sees the env.
  const { supabase } = await import("../src/services/supabase.js");
  const { listScenarios, loadScenarioBySlug } = await import("../src/services/scenarios.js");
  const { createSessionLink } = await import("../src/services/session-link.js");
  if (!supabase) skip("Supabase service-role client unavailable");

  // ── Seed applied? (migration 0023: family rows + catalog_visible column) ───
  const { data, error } = await supabase
    .from("scenarios")
    .select("id, slug, catalog_visible")
    .eq("family_id", FAMILY2.familyId);
  if (error) {
    if (/catalog_visible/i.test(error.message)) {
      skip("scenarios.catalog_visible column missing — migration 0023 not applied");
    }
    skip(`scenarios read failed: ${error.message}`);
  }
  const rows = (data ?? []) as Array<{ id: string; slug: string; catalog_visible: boolean | null }>;
  if (rows.length === 0) skip(`family 2 (${FAMILY2.familyId}) not seeded — apply migration 0023 first`);
  console.log(`  family-2 members: ${rows.map((r) => r.slug).join(", ")}`);

  // ── [a] catalog_visible = false on every member ─────────────────────────────
  console.log("\n[a] dormancy flag");
  const visible = rows.filter((r) => r.catalog_visible !== false);
  if (visible.length === 0) pass(`all ${rows.length} family-2 scenarios have catalog_visible = false`);
  else fail(`family-2 scenario(s) visible before activation: ${visible.map((r) => `${r.slug}=${r.catalog_visible}`).join(", ")}`);

  // ── [b] catalog excludes family 2; family 1 unaffected ─────────────────────
  console.log("\n[b] catalog listing (listScenarios — what GET /api/scenarios serves)");
  const catalog = await listScenarios();
  const leaked = catalog.filter((c) => c.slug.startsWith(FAMILY2.familyId));
  if (leaked.length === 0) pass("no family-2 slug appears in the catalog");
  else fail(`family-2 leaked into the catalog: ${leaked.map((c) => c.slug).join(", ")}`);
  if (catalog.some((c) => c.slug === "fde-db-triage")) pass("family 1 (fde-db-triage) still lists — catalog intact");
  else fail("family 1 missing from the catalog — the dormancy filter over-hides");

  // ── [c] direct slug load stays open (internal calibration path) ─────────────
  console.log("\n[c] direct-by-slug (internal calibration path)");
  const direct = await loadScenarioBySlug(FAMILY2.canonicalSlug);
  if (direct && direct.slug === FAMILY2.canonicalSlug)
    pass(`loadScenarioBySlug('${FAMILY2.canonicalSlug}') returns the scenario — /start by explicit slug remains possible (documented calibration path)`);
  else fail(`loadScenarioBySlug('${FAMILY2.canonicalSlug}') returned null — calibration path broken`);

  // ── [d] admin session-link mint for the hidden scenario ────────────────────
  console.log("\n[d] admin calibration link");
  const { data: orgRow } = await supabase
    .from("orgs").select("id").eq("slug", "asaya").maybeSingle();
  const adminOrgId = (orgRow as { id: string } | null)?.id ?? null;
  if (!adminOrgId) console.log("  (orgs table/asaya org unavailable — minting without org, pre-0018 back-compat)");
  try {
    const { link } = await createSessionLink({
      candidateLabel: "family2-dormancy-verifier (calibration)",
      scenarioId: rows[0]!.id,
      ttlMinutes: 5,
      orgId: adminOrgId,
    });
    pass(`admin can mint a session link to the hidden scenario (link ${link.id}) — calibration stays possible while dormant`);
    // Cleanup: never leave a live (even 5-min) link to the dormant family.
    const { error: delErr } = await supabase.from("session_links").delete().eq("id", link.id);
    if (delErr) fail(`cleanup failed — DELETE the verifier link ${link.id} manually: ${delErr.message}`);
    else console.log(`  cleaned up verifier link ${link.id}`);
  } catch (err) {
    fail(`admin session-link mint for hidden scenario failed: ${(err as Error).message}`);
  }

  console.log("\nACTIVATION (manual, after cohort 1 closes — see header):");
  console.log(`  UPDATE scenarios SET catalog_visible = true WHERE family_id = '${FAMILY2.familyId}';`);

  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
