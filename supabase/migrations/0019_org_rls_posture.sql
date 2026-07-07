-- 0019_org_rls_posture.sql — P2.2: documentation-grade assertion of the
-- tenant-isolation posture. Everything here is idempotent; nothing changes
-- behavior on a database that already follows the convention.
--
-- THE MODEL (ground truth — do not "fix" this by adding auth.uid() policies):
--
--   1. RLS is ENABLED on every table with ZERO policies. In Postgres, RLS
--      enabled + no policies = DENY-ALL for any role subject to RLS (anon,
--      authenticated). There are no Supabase Auth users in this system —
--      partners are represented by an API key per org, checked by the Fastify
--      server — so there is no auth.uid() to write policies against.
--
--   2. ALL app traffic goes through the server's SERVICE-ROLE client, which
--      BYPASSES RLS entirely. Therefore org isolation is enforced at the APP
--      layer: every /api/review/* route requires an org API key (X-Org-Key →
--      services/orgs.ts resolveOrgByApiKey) and scopes every query by the
--      resolved org's id (role 'admin' — the asaya org — sees everything).
--      The outcomes webhook authenticates with a per-org webhook secret and
--      stamps outcomes.org_id from the resolved org.
--
--   3. The deny-all RLS posture is the DB BACKSTOP: if the browser-shipped
--      anon key (or a leaked authenticated JWT) ever reaches PostgREST
--      directly, it reads/writes nothing. Defense in depth, not the primary
--      isolation mechanism.
--
-- (a) Assert RLS is enabled on orgs + the org-scoped tables. ENABLE ROW LEVEL
--     SECURITY is idempotent — a no-op where already enabled.
ALTER TABLE orgs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcomes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_links   ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcome_invites ENABLE ROW LEVEL SECURITY;

-- (b) Defense in depth on orgs, mirroring the 0017 pattern: Supabase's default
--     privileges GRANT table access to anon/authenticated EXPLICITLY on new
--     public tables, and deny-all RLS already blocks them — but orgs carries
--     API-key and webhook-secret hashes, so revoke the grants by name too.
--     Belt and braces: even a future accidental permissive policy would then
--     still not expose the hashes to the browser-shipped anon key.
REVOKE ALL ON TABLE orgs FROM PUBLIC, anon, authenticated;

-- (c) Durable in-catalog documentation of the model above.
COMMENT ON TABLE orgs IS
  'Tenant orgs. Auth = per-org API key (sha256 in api_key_hash, checked app-side); '
  'no Supabase Auth users. RLS enabled with zero policies = deny-all backstop; '
  'service-role only. Org isolation is enforced in the Fastify routes '
  '(services/orgs.ts requireOrg + per-query org scoping).';
COMMENT ON COLUMN orgs.api_key_hash IS
  'sha256 of the per-org API key (X-Org-Key header). Raw key shown once at mint.';
COMMENT ON COLUMN orgs.webhook_secret_hash IS
  'sha256 of the per-org outcomes webhook secret (Bearer). Raw shown once at mint. '
  'Legacy global OUTCOMES_WEBHOOK_SECRET is still accepted and attributed to the '
  'default asaya org — deprecate after partners migrate.';
