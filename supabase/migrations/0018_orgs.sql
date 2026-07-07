-- 0018_orgs.sql — P2.1: real tenant orgs behind the 0012 nullable org_id seam.
--
-- Partners are represented by an API KEY PER ORG (no Supabase Auth users, no
-- login UI): api_key_hash authenticates /api/review/* requests, and
-- webhook_secret_hash replaces the single global OUTCOMES_WEBHOOK_SECRET so
-- partner A can never post outcomes attributed to partner B. Only SHA-256
-- hashes are stored — raw secrets are shown once at mint time (same pattern as
-- session_links / outcome_invites token hashes). Both are NULLABLE: an org row
-- can exist before its key is minted (scripts/mint-org-key.ts).
--
-- Scenarios/families stay GLOBAL (asaya IP) — org_id scoping applies to
-- sessions, outcomes, session_links, outcome_invites only. The bare
-- scenarios.org_id column from 0012 is intentionally left nullable and unused.
--
-- The default 'asaya' org (role 'admin') is the backfill target for every
-- pre-P2 row and acts as the internal/admin tenant: its API key sees all orgs'
-- data; partner orgs (role 'partner') see only their own.
--
-- OPERATIONAL NOTE: apply during a quiet window. A pre-P2 writer (an old
-- server still omitting org_id) racing the backfill can insert a NULL org_id
-- row between the UPDATE and the NOT NULL step, which fails this migration at
-- VALIDATE CONSTRAINT. The migration is RETRY-SAFE: re-running re-does the
-- backfill and re-validates, so just retry once the old writers are gone.

CREATE TABLE IF NOT EXISTS orgs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  slug                TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL DEFAULT 'active'  CHECK (status IN ('active', 'suspended')),
  role                TEXT NOT NULL DEFAULT 'partner' CHECK (role IN ('admin', 'partner')),
  settings            JSONB NOT NULL DEFAULT '{}',
  api_key_hash        TEXT UNIQUE,        -- sha256 of the per-org API key (X-Org-Key)
  webhook_secret_hash TEXT UNIQUE,        -- sha256 of the per-org outcomes webhook secret
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS parity with the rest of the schema: ENABLED with ZERO policies =
-- deny-all for anon/authenticated. All app traffic uses the service role
-- (bypasses RLS); org isolation is enforced at the APP layer (routes require
-- an org key and scope every query). See 0019 for the full posture note.
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;

-- Default org — backfill target for all pre-P2 rows. api_key_hash stays NULL
-- until minted via scripts/mint-org-key.ts.
INSERT INTO orgs (name, slug, role)
VALUES ('asaya', 'asaya', 'admin')
ON CONFLICT (slug) DO NOTHING;

-- ── session_links.org_id (0016 shipped without the tenant seam) ─────────────
-- Nullable first; backfilled + SET NOT NULL below.
ALTER TABLE session_links ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES orgs(id);

-- ── Backfill every existing row to the default org ──────────────────────────
UPDATE sessions        SET org_id = (SELECT id FROM orgs WHERE slug = 'asaya') WHERE org_id IS NULL;
UPDATE outcomes        SET org_id = (SELECT id FROM orgs WHERE slug = 'asaya') WHERE org_id IS NULL;
UPDATE outcome_invites SET org_id = (SELECT id FROM orgs WHERE slug = 'asaya') WHERE org_id IS NULL;
UPDATE session_links   SET org_id = (SELECT id FROM orgs WHERE slug = 'asaya') WHERE org_id IS NULL;

-- ── FKs on the bare 0012/0013 uuid columns ───────────────────────────────────
-- 0012 (sessions, outcomes) and 0013 (outcome_invites) added org_id as a bare
-- UUID with no FK. Add the FKs NOT VALID first (no full-table lock on
-- validation of existing rows at ADD time), then VALIDATE — safe on live data.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_org_id_fkey') THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_org_id_fkey
      FOREIGN KEY (org_id) REFERENCES orgs(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outcomes_org_id_fkey') THEN
    ALTER TABLE outcomes ADD CONSTRAINT outcomes_org_id_fkey
      FOREIGN KEY (org_id) REFERENCES orgs(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outcome_invites_org_id_fkey') THEN
    ALTER TABLE outcome_invites ADD CONSTRAINT outcome_invites_org_id_fkey
      FOREIGN KEY (org_id) REFERENCES orgs(id) NOT VALID;
  END IF;
END $$;

ALTER TABLE sessions        VALIDATE CONSTRAINT sessions_org_id_fkey;
ALTER TABLE outcomes        VALIDATE CONSTRAINT outcomes_org_id_fkey;
ALTER TABLE outcome_invites VALIDATE CONSTRAINT outcome_invites_org_id_fkey;
-- session_links.org_id got its FK inline at ADD COLUMN above.

-- ── NOT NULL — every org-scoped row must carry its tenant from here on ──────
-- No column DEFAULT on purpose: the app must supply org_id explicitly (link
-- inheritance or the resolved default org), so a code path that forgets the
-- tenant fails loudly instead of silently landing in the default org.
--
-- Safe pattern instead of a plain SET NOT NULL (which takes an ACCESS
-- EXCLUSIVE lock for a full-table scan): add a CHECK (org_id IS NOT NULL)
-- NOT VALID (metadata-only), VALIDATE it (SHARE UPDATE EXCLUSIVE — concurrent
-- writes keep flowing), then SET NOT NULL — on PG12+ the validated constraint
-- proves the invariant so SET NOT NULL skips the scan. The redundant CHECK is
-- dropped afterwards.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sessions', 'outcomes', 'outcome_invites', 'session_links'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = t || '_org_id_not_null'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (org_id IS NOT NULL) NOT VALID',
        t, t || '_org_id_not_null'
      );
    END IF;
  END LOOP;
END $$;

ALTER TABLE sessions        VALIDATE CONSTRAINT sessions_org_id_not_null;
ALTER TABLE outcomes        VALIDATE CONSTRAINT outcomes_org_id_not_null;
ALTER TABLE outcome_invites VALIDATE CONSTRAINT outcome_invites_org_id_not_null;
ALTER TABLE session_links   VALIDATE CONSTRAINT session_links_org_id_not_null;

-- PG12+ uses the just-validated CHECK constraints to skip the full-table scan.
ALTER TABLE sessions        ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE outcomes        ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE outcome_invites ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE session_links   ALTER COLUMN org_id SET NOT NULL;

-- The column-level NOT NULL now carries the invariant; drop the scaffolding.
ALTER TABLE sessions        DROP CONSTRAINT IF EXISTS sessions_org_id_not_null;
ALTER TABLE outcomes        DROP CONSTRAINT IF EXISTS outcomes_org_id_not_null;
ALTER TABLE outcome_invites DROP CONSTRAINT IF EXISTS outcome_invites_org_id_not_null;
ALTER TABLE session_links   DROP CONSTRAINT IF EXISTS session_links_org_id_not_null;

-- sessions_org / outcomes_org indexes exist from 0012; session_links needs one
-- (org-scoped list queries in /api/review/session-links).
CREATE INDEX IF NOT EXISTS session_links_org ON session_links (org_id);
