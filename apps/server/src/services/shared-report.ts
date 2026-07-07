// P4.2/P4.3 — the EXTERNAL-SAFE shared candidate report.
//
// This is the payload behind the PUBLIC GET /api/report/:token endpoint —
// whoever holds the link (a hiring manager, a candidate, anyone it gets
// forwarded to) sees exactly this and nothing else. The response is an
// ALLOWLIST, enforced twice:
//   1. every Supabase read below selects only external-safe columns, and
//   2. the assembled object is parsed through SharedReportSchema (.strict()
//      at every level), so an accidentally-added internal field is a thrown
//      error, not a leak.
//
// MUST NEVER appear here (spec P4.3): cost/spend, model names, raw
// transcript/events, sandbox ids, org ids, session ids, other candidates'
// data, suspicion factor details (kinds/counts/weights/contributions — those
// are recruiter-only, via the SuspicionPanel endpoint). Evidence carries seq
// numbers + judge notes only — seq numbers are meaningless without the
// (internal-only) event stream.

import { z } from "zod";
import { supabase } from "./supabase.js";
import { computeSuspicionScore, type SuspicionEventInput } from "./suspicion-score.js";
import {
  AI_FLUENCY_COMPETENCY,
  aiFluencyPlacement,
} from "./ai-fluency.js";

export class SharedReportError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SharedReportError";
  }
}

// ── P5.1: sessions.difficulty_band may not exist yet (0020 unapplied) ────────
// Same latch/retry pattern as routes/review.ts: select the column
// optimistically; on the first missing-column error flip the latch and retry
// (and keep running) without it — the report shows band = null, not a 500.
let reportBandColumnMissing = false;

function isMissingBandColumn(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return err.code === "42703" && /difficulty_band/i.test(err.message ?? "");
}

// ── The allowlist ────────────────────────────────────────────────────────────

export const SharedReportSchema = z
  .object({
    scenario: z.object({ title: z.string(), role: z.string() }).strict(),
    candidate_label: z.string().nullable(),
    difficulty_band: z.string().nullable(),
    created_at: z.string(),
    ended_at: z.string().nullable(),
    overall_score: z.number().nullable(),
    scorable: z.boolean().nullable(),
    exclusion_reason: z.string().nullable(),
    verification: z
      .object({
        defense_outcome: z.string().nullable(),
        cap_status: z.string().nullable(),
      })
      .strict(),
    competencies: z.array(
      z
        .object({
          key: z.string(),
          score: z.number().nullable(),
          assessed: z.boolean(),
          rationale: z.string(),
          evidence: z.array(
            z.object({ event_seq: z.number(), note: z.string() }).strict(),
          ),
        })
        .strict(),
    ),
    ai_fluency: z
      .object({
        placement: z.enum(["ai_dependent", "ai_augmented", "ai_orchestrator"]).nullable(),
        informational: z.literal(true),
      })
      .strict(),
    // Score + version only — the per-factor breakdown is recruiter-facing and
    // must not leave through the public share link.
    suspicion: z
      .object({
        score: z.number(),
        version: z.string(),
        informational: z.literal(true),
      })
      .strict(),
    share: z.object({ expires_at: z.string() }).strict(),
  })
  .strict();

export type SharedReport = z.infer<typeof SharedReportSchema>;

/** Coerce stored evidence JSONB into the external shape; anything malformed
 *  is dropped rather than passed through. */
function safeEvidence(raw: unknown): Array<{ event_seq: number; note: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ event_seq: number; note: string }> = [];
  for (const e of raw) {
    if (e && typeof e === "object") {
      const seq = (e as Record<string, unknown>)["event_seq"];
      const note = (e as Record<string, unknown>)["note"];
      if (typeof seq === "number" && Number.isFinite(seq)) {
        out.push({ event_seq: seq, note: typeof note === "string" ? note : "" });
      }
    }
  }
  return out;
}

/** Assemble the external-safe report for one session. `expiresAt` is the
 *  share row's expiry, echoed so the page can show "link expires …". */
export async function buildSharedReport(
  sessionId: string,
  expiresAt: string,
): Promise<SharedReport> {
  if (!supabase) throw new SharedReportError("Supabase service-role client unavailable");

  // Session: allowlisted columns ONLY — never select("*") here.
  const SESSION_COLS =
    "id, scenario_id, created_at, ended_at, scorable, exclusion_reason, defense_outcome, verification_cap_status";
  const readSession = (withBand: boolean) =>
    supabase!
      .from("sessions")
      .select(withBand ? `${SESSION_COLS}, difficulty_band` : SESSION_COLS)
      .eq("id", sessionId)
      .maybeSingle();

  let sessRes = await readSession(!reportBandColumnMissing);
  if (sessRes.error && !reportBandColumnMissing && isMissingBandColumn(sessRes.error)) {
    reportBandColumnMissing = true;
    console.warn(
      "[shared-report] sessions.difficulty_band missing (migration 0020 not applied) — reporting without band",
    );
    sessRes = await readSession(false);
  }
  const { data: sess, error: sessErr } = sessRes;
  if (sessErr) throw new SharedReportError(`session read failed: ${sessErr.message}`);
  if (!sess) throw new SharedReportError(`session ${sessionId} not found`);
  const session = sess as unknown as {
    id: string;
    scenario_id: string | null;
    created_at: string;
    ended_at: string | null;
    // Absent on a pre-0020 database (see the band-column latch above).
    difficulty_band?: string | null;
    scorable: boolean | null;
    exclusion_reason: string | null;
    defense_outcome: string | null;
    verification_cap_status: string | null;
  };

  const [scenRes, evalRes, linkRes, eventsRes] = await Promise.all([
    session.scenario_id
      ? supabase.from("scenarios").select("title, role").eq("id", session.scenario_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase
      .from("evaluations")
      .select("id, overall_score, status")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("session_links")
      .select("candidate_label")
      .eq("session_id", sessionId)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("events")
      .select("seq, type, ts, payload")
      .eq("session_id", sessionId)
      .like("type", "integrity.%")
      .order("seq", { ascending: true })
      .limit(1000),
  ]);
  for (const res of [scenRes, evalRes, linkRes, eventsRes]) {
    if (res.error) throw new SharedReportError(`report child read failed: ${res.error.message}`);
  }

  const scenario = (scenRes.data ?? null) as { title: string; role: string } | null;
  const evalRow = (evalRes.data ?? null) as {
    id: string;
    overall_score: number | string | null;
    status: string;
  } | null;
  const complete = evalRow !== null && evalRow.status === "complete";

  let competencies: SharedReport["competencies"] = [];
  if (evalRow && complete) {
    const { data: items, error: itemsErr } = await supabase
      .from("evaluation_items")
      .select("competency, score, assessed, rationale, evidence")
      .eq("evaluation_id", evalRow.id)
      .order("competency", { ascending: true });
    if (itemsErr) throw new SharedReportError(`evaluation_items read failed: ${itemsErr.message}`);
    competencies = ((items ?? []) as Array<{
      competency: string;
      score: number | string | null;
      assessed: boolean | null;
      rationale: string | null;
      evidence: unknown;
    }>).map((it) => ({
      key: it.competency,
      score: it.score === null ? null : Number(it.score),
      assessed: it.assessed !== false && it.score !== null,
      rationale: it.rationale ?? "",
      evidence: safeEvidence(it.evidence),
    }));
  }

  const aiItem = competencies.find((c) => c.key === AI_FLUENCY_COMPETENCY);
  const suspicion = computeSuspicionScore(
    (eventsRes.data ?? []) as unknown as SuspicionEventInput[],
  );

  // Final gate: strict parse = allowlist. A stray internal field anywhere in
  // this object throws here instead of leaving the building.
  return SharedReportSchema.parse({
    scenario: {
      title: scenario?.title ?? "Assessment",
      role: scenario?.role ?? "unknown",
    },
    candidate_label:
      (linkRes.data as { candidate_label: string } | null)?.candidate_label ?? null,
    difficulty_band: session.difficulty_band ?? null,
    created_at: session.created_at,
    ended_at: session.ended_at,
    overall_score:
      complete && evalRow.overall_score !== null ? Number(evalRow.overall_score) : null,
    scorable: session.scorable,
    exclusion_reason: session.exclusion_reason,
    verification: {
      defense_outcome: session.defense_outcome,
      cap_status: session.verification_cap_status,
    },
    competencies,
    ai_fluency: {
      placement: aiFluencyPlacement(aiItem?.assessed ? aiItem.score : null),
      informational: true,
    },
    suspicion: {
      score: suspicion.score,
      version: suspicion.version,
      informational: true,
    },
    share: { expires_at: expiresAt },
  });
}
