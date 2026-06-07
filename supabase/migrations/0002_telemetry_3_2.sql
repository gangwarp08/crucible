-- Crucible — telemetry source wiring (Week 3.2)
--
-- Adds the columns needed by the real pty/file/chat telemetry sources, plus
-- the dedup/cost-link metadata exposed by the LiteLLM gateway.
--
-- Note on cost_ledger.transcript_id: during 3.2 implementation, this column
-- briefly carried an FK to transcript(id). The FK was dropped because the
-- transcript INSERT and the cost_ledger INSERT fire concurrently from the
-- chat route (both as fire-and-forget telemetry writes), so the FK could
-- not be reliably satisfied without serialising the two paths. The column
-- is retained as a logical join, not an enforced constraint — so the fresh
-- state simply never declares the FK.

-- ── transcript: full per-turn LLM metadata ──────────────────────────────────
ALTER TABLE transcript
  ADD COLUMN model             TEXT,
  ADD COLUMN prompt_tokens     INTEGER,
  ADD COLUMN completion_tokens INTEGER,
  ADD COLUMN total_tokens      INTEGER,
  ADD COLUMN cost_usd          NUMERIC(12, 8),
  ADD COLUMN latency_ms        INTEGER,
  ADD COLUMN finish_reason     TEXT,
  ADD COLUMN litellm_call_id   TEXT;

-- ── cost_ledger: tie each charge to its session-cumulative spend and call ───
ALTER TABLE cost_ledger
  ADD COLUMN purpose              TEXT,
  ADD COLUMN cumulative_spend_usd NUMERIC(12, 8),
  ADD COLUMN litellm_call_id      TEXT,
  ADD COLUMN transcript_id        UUID;

-- ── file_snapshots: dedup hash + size, action verb, and nullable content ────
ALTER TABLE file_snapshots
  ADD COLUMN action       TEXT NOT NULL DEFAULT 'write',
  ADD COLUMN size_bytes   INTEGER,
  ADD COLUMN content_hash TEXT;

ALTER TABLE file_snapshots
  ALTER COLUMN content DROP NOT NULL;
