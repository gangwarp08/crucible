-- 0029_provenance_records.sql — verification pipeline (slice V6): signed,
-- hash-chained provenance records.
--
-- One row per session, written fire-and-forget at session end (and
-- recomputable on demand): a compact, SIGNED artifact binding the session's
-- telemetry (rolling SHA-256 chain over the append-only events stream), the
-- deliverable hash, the derived identity-check hash, and the verification-
-- confidence aggregate. Third parties verify the Ed25519 signature offline
-- against the published public key (GET /api/provenance/public-key).
--
-- DATA POSTURE: HASHES AND AGGREGATES ONLY — no biometrics, no raw telemetry,
-- no candidate content. This is the cross-border-safe artifact: it can travel
-- (e.g. inside a shared report) while raw data stays region-pinned. Because it
-- contains no biometric-class data, this migration is NOT counsel-gated and is
-- applied normally (unlike 0024/0027).
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS provenance_records (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  org_id     UUID NOT NULL REFERENCES orgs(id),
  -- The canonical record that was signed (jsonb for queryability; the
  -- SIGNATURE is over the sorted-key canonical JSON string of exactly this
  -- object — services/provenance.ts canonicalize()).
  record     JSONB NOT NULL,
  -- Ed25519 signature, base64.
  signature  TEXT NOT NULL,
  -- Identifies the signing keypair (sha256 of the public key DER, first 16
  -- hex) so records survive key rotation verifiably.
  key_id     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE provenance_records IS
  'Slice V6: signed hash-chained session provenance. record = {chain head over events, deliverable hash, identity hash, verification aggregate, versions}; signature = Ed25519 over canonical JSON. Hashes/aggregates only — no biometrics or raw telemetry.';

-- RLS parity (0019 posture): deny-all; service role only.
ALTER TABLE provenance_records ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_provenance_records_org ON provenance_records (org_id);
