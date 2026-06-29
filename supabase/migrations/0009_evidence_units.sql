-- Crucible — L5 Stage A: deterministic evidence units (Slice 5.2)
--
-- Splits evaluation into two stages. Stage A (this table) is produced by code,
-- not the LLM: services/evidence-extractor.ts reads the append-only event stream
-- + ground truth and emits typed, deterministic evidence units, each tied to a
-- competency and the exact event_seqs that produced it. Stage B (the Analysis
-- Agent, refactored in Slice 5.3) interprets these units instead of the raw
-- firehose, and cites unit ids — making the hallucinated-seq filter structural.
--
-- Units are SESSION-scoped (not evaluation-scoped): they are regenerated from
-- the durable event stream on each extraction (DELETE-then-INSERT by session),
-- so re-scoring never depends on a prior evaluation row.
--
-- RLS enabled, no policies — service-role only (CLAUDE.md Hard Rule §2).

CREATE TABLE evidence_units (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  competency_key   TEXT NOT NULL,
  kind             TEXT NOT NULL,
  value            JSONB NOT NULL DEFAULT '{}'::jsonb,
  weight           NUMERIC NOT NULL DEFAULT 1,
  event_seqs       INTEGER[] NOT NULL DEFAULT '{}',
  detector_version TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX evidence_units_session            ON evidence_units (session_id);
CREATE INDEX evidence_units_session_competency ON evidence_units (session_id, competency_key);

ALTER TABLE evidence_units ENABLE ROW LEVEL SECURITY;
