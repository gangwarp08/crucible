/**
 * verify-orgs-schema.ts — P2.1 acceptance (migration 0018).
 *
 * Runs against the LIVE database, so it only READS plus inserts/deletes its
 * own synthetic rows:
 *
 *   [a] default 'asaya' org exists (backfill target, role admin);
 *   [b] backfill completeness — zero NULL org_id rows on sessions / outcomes /
 *       session_links / outcome_invites;
 *   [c] new-row NOT NULL enforcement — inserting WITHOUT org_id is rejected
 *       on all four tables (any accidental success is deleted and FAILS).
 *
 * SKIPs gracefully (exit 0) when Supabase creds are absent or the orgs table
 * does not exist yet (0018 not applied). Exit 0 PASS / 1 FAIL.
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { randomUUID, randomBytes, createHash } from "crypto";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const url =
  process.env.SUPABASE_URL ??
  (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : null);
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

async function main(): Promise<void> {
  console.log("verify-orgs-schema — P2.1 (migration 0018)");
  if (!url || !key) {
    console.log("  ⚠ SKIP — Supabase creds absent");
    process.exit(0);
  }
  const { supabase } = await import("../src/services/supabase.js");
  if (!supabase) {
    console.log("  ⚠ SKIP — service-role client unavailable");
    process.exit(0);
  }

  // ── Gate: orgs table present? ──────────────────────────────────────────
  const probe = await supabase.from("orgs").select("id").limit(1);
  if (probe.error) {
    console.log(`  ⚠ SKIP — orgs table not found (migration 0018 not applied yet): ${probe.error.message}`);
    process.exit(0);
  }

  // ── [a] default org ─────────────────────────────────────────────────────
  console.log("\n[a] default org");
  const { data: def, error: defErr } = await supabase
    .from("orgs")
    .select("id, slug, role, status")
    .eq("slug", "asaya")
    .maybeSingle();
  check("default 'asaya' org exists", !defErr && !!def, defErr?.message);
  check("default org has role 'admin'", (def as { role?: string } | null)?.role === "admin");
  const defaultOrgId = (def as { id: string } | null)?.id ?? null;

  // ── [b] backfill completeness ───────────────────────────────────────────
  console.log("\n[b] backfill completeness (no NULL org_id rows)");
  for (const table of ["sessions", "outcomes", "session_links", "outcome_invites"] as const) {
    const { count, error } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .is("org_id", null);
    check(`${table}: zero NULL org_id rows`, !error && (count ?? -1) === 0,
      error ? error.message : `count=${count}`);
  }

  // ── [c] new rows REQUIRE org_id ─────────────────────────────────────────
  console.log("\n[c] new-row NOT NULL enforcement (insert without org_id must fail)");
  const suffix = randomBytes(4).toString("hex");

  async function expectRejected(
    table: string,
    row: Record<string, unknown>,
  ): Promise<void> {
    const inserted = await supabase!.from(table).insert(row).select("id").maybeSingle();
    if (!inserted.error && inserted.data) {
      // Should not have landed — remove the synthetic row and fail.
      await supabase!.from(table).delete().eq("id", (inserted.data as { id: string }).id);
      check(`${table}: insert without org_id rejected`, false, "insert unexpectedly succeeded");
      return;
    }
    const notNull =
      inserted.error?.code === "23502" || /null value.*org_id|org_id.*not-null/i.test(inserted.error?.message ?? "");
    check(`${table}: insert without org_id rejected (not-null)`, notNull, inserted.error?.message);
  }

  await expectRejected("sessions", {
    id: randomUUID(),
    sandbox_id: `verify-orgs-${suffix}`,
    template: "verify",
    litellm_key_alias: `verify-orgs-${suffix}`,
    model: "none",
    budget_usd: 0,
    timeout_min: 1,
    deadline: new Date(Date.now() + 60_000).toISOString(),
  });

  await expectRejected("outcomes", {
    candidate_ref: `verify-orgs-${suffix}`,
    outcome_type: "hired",
    outcome_value: { value: true },
    source: "manual",
  });

  await expectRejected("session_links", {
    token_hash: createHash("sha256").update(`verify-orgs-${suffix}`).digest("hex"),
    candidate_label: `verify-orgs-${suffix}`,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });

  // outcome_invites needs a real session (session_id NOT NULL + FK) — seed a
  // synthetic one WITH org_id, try the invite WITHOUT, then clean up.
  if (defaultOrgId) {
    const seedSessionId = randomUUID();
    const { error: seedErr } = await supabase.from("sessions").insert({
      id: seedSessionId,
      sandbox_id: `verify-orgs-${suffix}`,
      template: "verify",
      litellm_key_alias: `verify-orgs-inv-${suffix}`,
      model: "none",
      budget_usd: 0,
      timeout_min: 1,
      deadline: new Date(Date.now() + 60_000).toISOString(),
      status: "completed",
      org_id: defaultOrgId,
    });
    if (seedErr) {
      check("outcome_invites: insert without org_id rejected", false, `seed session failed: ${seedErr.message}`);
    } else {
      await expectRejected("outcome_invites", {
        token_hash: createHash("sha256").update(`verify-orgs-inv-${suffix}`).digest("hex"),
        session_id: seedSessionId,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      await supabase.from("sessions").delete().eq("id", seedSessionId);
    }
  } else {
    check("outcome_invites: insert without org_id rejected", false, "no default org to seed a session with");
  }

  console.log(failed === 0 ? "\nPASS — 0018 backfill + NOT NULL hold" : `\nFAIL — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-orgs-schema crashed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
