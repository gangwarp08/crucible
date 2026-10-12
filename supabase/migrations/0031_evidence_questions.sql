-- 0031_evidence_questions.sql — verification pipeline (slice V8): cached
-- evidence-conversation question sets.
--
-- The "evidence conversation": within ~48h of a session, an interviewer asks
-- the candidate about their OWN recorded work ("why did you reject the AI's
-- first approach at minute 31?"). The questions are generated once per session
-- from the telemetry's highest-information moments (deterministic selection +
-- one LLM phrasing call) and cached here so the review surface doesn't re-pay
-- the model on every view. Derived content only: questions + cited event seqs.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS evidence_question_sets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     UUID NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  org_id         UUID NOT NULL REFERENCES orgs(id),
  -- [{question, event_seqs, rationale}] — Zod-validated before insert.
  questions      JSONB NOT NULL,
  model          TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE evidence_question_sets IS
  'Slice V8: per-session evidence-conversation questions (deterministic moment selection + one LLM phrasing call), cached. Derived content only — questions + cited event seqs.';

-- RLS parity (0019 posture): deny-all; service role only.
ALTER TABLE evidence_question_sets ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_evidence_question_sets_org ON evidence_question_sets (org_id);
