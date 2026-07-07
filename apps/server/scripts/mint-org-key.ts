/**
 * mint-org-key.ts — P2 operator tool: create/rotate an org's secrets.
 *
 *   pnpm --filter @crucible/server exec tsx scripts/mint-org-key.ts <slug> [name]
 *
 * Looks up the org by slug; creates it if missing (name defaults to the slug).
 * Then mints (ROTATES — any previously issued values stop working) both the
 * org API key and the outcomes webhook secret, and prints the raw values ONCE.
 * Only SHA-256 hashes are stored; there is no way to recover a lost raw —
 * re-run this script to rotate.
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const slug = process.argv[2];
const name = process.argv[3] ?? slug;

async function main(): Promise<void> {
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    console.error("Usage: tsx scripts/mint-org-key.ts <slug> [name]   (slug: lowercase, digits, dashes)");
    process.exit(1);
  }

  const { supabase } = await import("../src/services/supabase.js");
  if (!supabase) {
    console.error("Supabase creds absent (SUPABASE_URL/PROJECT_REF + SUPABASE_SERVICE_ROLE_KEY)");
    process.exit(1);
  }
  const { mintOrgApiKey, mintOrgWebhookSecret } = await import("../src/services/orgs.js");

  // Find or create the org row.
  const { data: existing, error: findErr } = await supabase
    .from("orgs")
    .select("id, name, slug, role, status, api_key_hash, webhook_secret_hash")
    .eq("slug", slug)
    .maybeSingle();
  if (findErr) {
    console.error(`org lookup failed: ${findErr.message} (is migration 0018 applied?)`);
    process.exit(1);
  }

  let orgId: string;
  if (existing) {
    orgId = (existing as { id: string }).id;
    const had = existing as { api_key_hash: string | null; webhook_secret_hash: string | null };
    console.log(`Org '${slug}' exists (${orgId}).`);
    if (had.api_key_hash || had.webhook_secret_hash) {
      console.log("WARNING: minting ROTATES existing secrets — previously issued values stop working.");
    }
  } else {
    const { data: created, error: insErr } = await supabase
      .from("orgs")
      .insert({ name: name ?? slug, slug })
      .select("id")
      .single();
    if (insErr || !created) {
      console.error(`org create failed: ${insErr?.message ?? "no row returned"}`);
      process.exit(1);
    }
    orgId = (created as { id: string }).id;
    console.log(`Created org '${slug}' (${orgId}, role=partner).`);
  }

  const apiKey = await mintOrgApiKey(orgId);
  const webhookSecret = await mintOrgWebhookSecret(orgId);

  console.log("");
  console.log("Store these NOW — they are shown once and only hashes are persisted:");
  console.log(`  Org API key (X-Org-Key):        ${apiKey}`);
  console.log(`  Outcomes webhook secret (Bearer): ${webhookSecret}`);
  console.log(`  Partner review link (share this single URL): https://tryassaya.com/review?key=${apiKey}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
