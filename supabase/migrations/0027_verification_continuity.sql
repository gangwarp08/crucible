-- 0027_verification_continuity.sql — verification pipeline (continuity, DORMANT):
-- identity_anchors + reverify columns on identity_checks.
--
-- ⚠ AUTHORED, NOT APPLIED. Same dormancy contract as 0024 (which must be
-- applied first — identity_checks is referenced below): do not run until
-- counsel signs off consent language v2 + data-handling for the target
-- jurisdiction. Face EMBEDDINGS are biometric-identifier-class data under
-- BIPA/DPDP even though no image is stored. The server code is skip-graceful
-- when these tables/columns are absent.
--
-- DATA MINIMIZATION (the load-bearing property, extended from 0024):
--   - identity_anchors stores a numeric EMBEDDING VECTOR derived in the
--     candidate's browser from the enrolment selfie — never the selfie, never
--     any frame. There is deliberately NO column that could hold image bytes.
--   - Continuity samples (the periodic webcam re-match) NEVER persist their
--     embeddings: the server computes cosine similarity against the anchor and
--     discards the sample vector; only the derived similarity lands in the
--     events stream (integrity.face_match {similarity}).
--   - model_version pins the embedder that produced the vector: vectors are
--     meaningless across embedder versions, so compares are version-gated.
--   - Deletion path: deleteIdentityData (services/proctoring-v2.ts) hard-
--     deletes anchors with the identity_checks rows — plus ON DELETE CASCADE
--     with the session.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS identity_anchors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  org_id        UUID NOT NULL REFERENCES orgs(id),
  -- The enrolment embedding (browser-computed, L2-normalized). Plain float8[]
  -- on purpose: cosine similarity over one row per session needs no pgvector.
  embedding     DOUBLE PRECISION[] NOT NULL,
  dim           INTEGER NOT NULL CHECK (dim > 0 AND dim <= 2048),
  -- Embedder identifier+version (e.g. 'luma-grid-v0'). A compare is only
  -- valid between vectors of the same model_version.
  model_version TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE identity_anchors IS
  'Verification continuity (dormant): browser-computed enrolment face embedding per session. DERIVED DATA ONLY — no image bytes anywhere; continuity sample vectors are compared in memory and discarded. Hard-deletable via the identity-delete endpoint; cascades with the session.';

-- RLS parity with the rest of the schema (0019 posture): ENABLED with ZERO
-- policies = deny-all for anon/authenticated. All app traffic uses the
-- service role; org isolation is enforced at the app layer.
ALTER TABLE identity_anchors ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_identity_anchors_org ON identity_anchors (org_id);

-- ── Day-one re-verify (slice V10, same dormancy) ─────────────────────────────
-- A reverify micro-session's identity check records which ORIGINAL session it
-- re-verifies and the cosine similarity of the fresh enrolment embedding
-- against the ORIGINAL session's anchor ("same person on day one").
ALTER TABLE identity_checks
  ADD COLUMN IF NOT EXISTS reverify_of       UUID REFERENCES sessions(id),
  ADD COLUMN IF NOT EXISTS anchor_similarity NUMERIC;

COMMENT ON COLUMN identity_checks.reverify_of IS
  'When this check belongs to a day-one reverify micro-session: the original session it re-verifies.';
COMMENT ON COLUMN identity_checks.anchor_similarity IS
  'Cosine similarity of the reverify enrolment embedding vs the ORIGINAL session''s anchor (same model_version only).';

CREATE INDEX IF NOT EXISTS idx_identity_checks_reverify ON identity_checks (reverify_of);
