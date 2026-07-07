// Recruiter review endpoints — READ-ONLY from Supabase.
// These power the post-session review UI. They MUST work for ended sessions
// no longer in the in-memory registry, so all data comes from Supabase via
// the server-only service-role client. Browser never queries Supabase directly.
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { supabase } from "../services/supabase.js";
import { runAnalysisAgent, reinterpretEvaluation, AnalysisError } from "../services/analysis-agent.js";
import {
  createInvite,
  listInvites,
  revokeInvite,
  OutcomeInviteError,
} from "../services/outcome-invites.js";
import { OUTCOME_TYPES, listSessionOutcomes } from "../services/outcomes.js";
import {
  createSessionLink,
  listSessionLinks,
  revokeSessionLink,
  SessionLinkError,
} from "../services/session-link.js";
import { persistSessionUpdate } from "../services/db.js";
import { appendEvent } from "../services/events-direct.js";
import { VERIFICATION_CAP_SCORE } from "../services/defense.js";

const LIST_LIMIT = 100;

const ParamsSchema = z.object({ id: z.string().uuid() });

interface SessionRow {
  id: string;
  status: string | null;
  end_reason: string | null;
  model: string | null;
  created_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  spend_usd: number | string;
}

export async function reviewRoutes(server: FastifyInstance) {
  if (!supabase) {
    server.log.warn("[review] supabase client unavailable — /api/review routes will 503");
  }

  // ─── List ────────────────────────────────────────────────────────────────
  server.get("/sessions", async (_request, reply) => {
    if (!supabase) {
      return reply.status(503).send({ error: "Supabase unavailable" });
    }

    const { data: sessions, error: sessErr } = await supabase
      .from("sessions")
      .select(
        "id, status, end_reason, model, created_at, ended_at, duration_ms, spend_usd",
      )
      .order("created_at", { ascending: false })
      .limit(LIST_LIMIT);

    if (sessErr) {
      server.log.error({ err: sessErr }, "[review] sessions list failed");
      return reply.status(500).send({ error: "Failed to load sessions" });
    }
    if (!sessions || sessions.length === 0) {
      return reply.send({ sessions: [] });
    }

    const ids = sessions.map((s) => s.id);

    // Two Postgres RPCs (migration 0017), fired in parallel: grouped
    // per-session counts over events/transcript/file_snapshots, and the
    // latest evaluation per session (DISTINCT ON). Aggregation happens in
    // the database, so only ~LIST_LIMIT rows cross the network instead of
    // up to 100k raw child rows per table.
    const [countsRes, evalsRes] = await Promise.all([
      supabase.rpc("review_session_counts", { ids }),
      supabase.rpc("review_latest_evaluations", { ids }),
    ]);

    for (const res of [countsRes, evalsRes]) {
      if (res.error) {
        server.log.error({ err: res.error }, "[review] count query failed");
        return reply.status(500).send({ error: "Failed to load session counts" });
      }
    }

    interface CountRow {
      session_id: string;
      event_count: number;
      message_count: number;
      file_count: number;
    }
    const eventCounts = new Map<string, number>();
    const msgCounts   = new Map<string, number>();
    const fileCounts  = new Map<string, number>();
    for (const r of (countsRes.data ?? []) as CountRow[]) {
      eventCounts.set(r.session_id, r.event_count);
      msgCounts.set(r.session_id, r.message_count);
      fileCounts.set(r.session_id, r.file_count);
    }

    // Latest-evaluation-per-session map — the RPC already returns exactly
    // one (most recent) row per session_id.
    interface EvalListRow {
      session_id: string;
      overall_score: number | string;
      status: string;
      created_at: string;
    }
    const latestEval = new Map<string, EvalListRow>();
    for (const r of (evalsRes.data ?? []) as EvalListRow[]) {
      latestEval.set(r.session_id, r);
    }

    const rows = (sessions as SessionRow[]).map((s) => {
      const ev = latestEval.get(s.id);
      return {
        id: s.id,
        status: s.status,
        end_reason: s.end_reason,
        model: s.model,
        created_at: s.created_at,
        ended_at: s.ended_at,
        duration_ms: s.duration_ms,
        spend_usd: s.spend_usd,
        event_count: eventCounts.get(s.id) ?? 0,
        messages:    msgCounts.get(s.id) ?? 0,
        file_saves:  fileCounts.get(s.id) ?? 0,
        overall_score:     ev ? Number(ev.overall_score) : null,
        evaluation_status: ev ? (ev.status as "complete" | "error") : null,
      };
    });

    return reply.send({ sessions: rows });
  });

  // ─── Detail ──────────────────────────────────────────────────────────────
  server.get<{ Params: { id: string } }>("/sessions/:id", async (request, reply) => {
    const parsed = ParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid session id (must be uuid)" });
    }
    if (!supabase) {
      return reply.status(503).send({ error: "Supabase unavailable" });
    }

    const id = parsed.data.id;

    // Fire all six parallel reads — they share no dependencies.
    // file_snapshots has no seq column, so we order it by ts (insertion order).
    // The latest evaluation per session is the most-recent row (re-evals
    // delete-then-insert but defence in depth: limit 1 ordered DESC).
    const [sessRes, eventsRes, transcriptRes, fileSnapshotsRes, costRes, evalRes] =
      await Promise.all([
        supabase.from("sessions").select("*").eq("id", id).maybeSingle(),
        supabase
          .from("events")
          .select("*")
          .eq("session_id", id)
          .order("seq", { ascending: true }),
        supabase
          .from("transcript")
          .select("*")
          .eq("session_id", id)
          .order("seq", { ascending: true }),
        supabase
          .from("file_snapshots")
          .select("*")
          .eq("session_id", id)
          .order("ts", { ascending: true }),
        supabase
          .from("cost_ledger")
          .select("*")
          .eq("session_id", id)
          .order("ts", { ascending: true }),
        supabase
          .from("evaluations")
          .select("*")
          .eq("session_id", id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

    if (sessRes.error) {
      server.log.error({ err: sessRes.error, id }, "[review] session lookup failed");
      return reply.status(500).send({ error: "Failed to load session" });
    }
    if (!sessRes.data) {
      return reply.status(404).send({ error: "Session not found" });
    }

    for (const res of [eventsRes, transcriptRes, fileSnapshotsRes, costRes, evalRes]) {
      if (res.error) {
        server.log.error({ err: res.error, id }, "[review] detail child query failed");
        return reply.status(500).send({ error: "Failed to load session detail" });
      }
    }

    // Conditionally fetch evaluation_items only when an evaluation exists.
    // Sequential here (depends on evalRes); cheap one-row-lookup pattern.
    let evaluation: Record<string, unknown> | null = null;
    if (evalRes.data) {
      const evalRow = evalRes.data as Record<string, unknown>;
      const { data: itemsData, error: itemsErr } = await supabase
        .from("evaluation_items")
        .select("competency, score, assessed, weight, rationale, evidence, created_at")
        .eq("evaluation_id", evalRow.id as string)
        .order("competency", { ascending: true });
      if (itemsErr) {
        server.log.error({ err: itemsErr, id }, "[review] evaluation_items load failed");
        // Don't fail the whole detail — return the eval header with empty items.
      }
      evaluation = { ...evalRow, items: itemsData ?? [] };
    }

    return reply.send({
      session:       sessRes.data,
      events:        eventsRes.data ?? [],
      transcript:    transcriptRes.data ?? [],
      fileSnapshots: fileSnapshotsRes.data ?? [],
      cost:          costRes.data ?? [],
      evaluation,
    });
  });

  // ─── Manual evaluation trigger (calibration / rubric iteration) ─────────
  // Runs the Analysis Agent against any completed session. Replaces any prior
  // evaluation for the same session_id (delete + insert, items cascade).
  // One LLM call per request; rate-limited to keep accidental loops cheap.
  server.post<{ Params: { id: string } }>(
    "/sessions/:id/evaluate",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const idParse = ParamsSchema.safeParse(request.params);
      if (!idParse.success) {
        return reply.status(400).send({ error: "Invalid session id" });
      }
      const sessionId = idParse.data.id;
      try {
        const result = await runAnalysisAgent(sessionId);
        return reply.send(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // AnalysisError covers "session not found", "no scenario", and
        // "has not ended" — all 400-class conditions surfaced to the caller.
        // LLM/parse failures inside runAnalysisAgent already persist a
        // status='error' row before re-throwing, so a 500 here still leaves
        // a recruiter-visible trace.
        if (err instanceof AnalysisError && /not found|no scenario|not ended/i.test(msg)) {
          return reply.status(400).send({ error: msg });
        }
        server.log.error({ err, sessionId }, "manual analysis failed");
        return reply.status(500).send({ error: "analysis failed", message: msg });
      }
    },
  );

  // Re-score over STORED evidence units only — runs Stage B (the LLM judge)
  // without re-running Stage A extraction or replaying the session (Slice 5.3).
  // Cheap calibration / judge A-B over historical sessions: one LLM call, no
  // sandbox, no playthrough. Same delete-then-insert persistence as /evaluate.
  server.post<{ Params: { id: string } }>(
    "/sessions/:id/reinterpret",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const idParse = ParamsSchema.safeParse(request.params);
      if (!idParse.success) {
        return reply.status(400).send({ error: "Invalid session id" });
      }
      const sessionId = idParse.data.id;
      try {
        const result = await reinterpretEvaluation(sessionId);
        return reply.send(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof AnalysisError && /not found|no scenario|not ended/i.test(msg)) {
          return reply.status(400).send({ error: msg });
        }
        server.log.error({ err, sessionId }, "reinterpret failed");
        return reply.status(500).send({ error: "reinterpret failed", message: msg });
      }
    },
  );

  // ─── Verification advisory cap: confirm / override (RD2, Slice 6.3) ─────
  // When a defense is weak/declined under the pilot advisory flag, the analysis
  // agent records verification_cap_status='advisory_pending' WITHOUT touching
  // the official score. A reviewer resolves it here:
  //   confirm  → cap execution to VERIFICATION_CAP_SCORE, recompute overall,
  //              persist, mark 'confirmed'.
  //   override → leave the score untouched, mark 'overridden'.
  // Idempotency: only an 'advisory_pending' session is resolvable (else 409),
  // so a double-click can't double-cap. Cheap arithmetic re-score — no LLM.
  const CapDecisionSchema = z.object({ decision: z.enum(["confirm", "override"]) });
  server.post<{ Params: { id: string } }>(
    "/sessions/:id/verification-cap",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!supabase) return reply.status(500).send({ error: "Supabase not configured" });
      const idParse = ParamsSchema.safeParse(request.params);
      if (!idParse.success) return reply.status(400).send({ error: "Invalid session id" });
      const bodyParse = CapDecisionSchema.safeParse(request.body);
      if (!bodyParse.success) {
        return reply.status(400).send({ error: "Body must be { decision: 'confirm' | 'override' }" });
      }
      const sessionId = idParse.data.id;
      const { decision } = bodyParse.data;

      const { data: sess, error: sessErr } = await supabase
        .from("sessions")
        .select("id, verification_cap_status, defense_outcome")
        .eq("id", sessionId)
        .maybeSingle();
      if (sessErr) {
        server.log.error({ err: sessErr, sessionId }, "[review] cap: session lookup failed");
        return reply.status(500).send({ error: "Failed to load session" });
      }
      if (!sess) return reply.status(404).send({ error: "Session not found" });
      if (sess.verification_cap_status !== "advisory_pending") {
        return reply.status(409).send({
          error: "no_pending_cap",
          message: `verification_cap_status is '${sess.verification_cap_status ?? "none"}', not 'advisory_pending'`,
        });
      }

      if (decision === "override") {
        await persistSessionUpdate(sessionId, { verification_cap_status: "overridden" });
        void appendEvent(sessionId, "verification.cap_overridden", "system", {
          defense_outcome: sess.defense_outcome,
        });
        return reply.send({ verification_cap_status: "overridden" });
      }

      // confirm → cap execution + recompute overall on the latest evaluation.
      const { data: evalRow, error: evalErr } = await supabase
        .from("evaluations")
        .select("id, overall_score")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (evalErr) {
        server.log.error({ err: evalErr, sessionId }, "[review] cap: evaluation lookup failed");
        return reply.status(500).send({ error: "Failed to load evaluation" });
      }
      if (!evalRow) {
        return reply.status(409).send({ error: "no_evaluation", message: "Session has no evaluation to cap" });
      }

      const { data: items, error: itemsErr } = await supabase
        .from("evaluation_items")
        .select("id, competency, score, weight, assessed")
        .eq("evaluation_id", evalRow.id as string);
      if (itemsErr || !items) {
        server.log.error({ err: itemsErr, sessionId }, "[review] cap: items load failed");
        return reply.status(500).send({ error: "Failed to load evaluation items" });
      }

      // Only an ASSESSED execution item with a real score above the cap moves.
      const execItem = items.find((it) => it.competency === "execution");
      const execAssessed = !!execItem && execItem.assessed !== false && execItem.score !== null;
      const priorExec = execAssessed ? Number(execItem!.score) : null;
      const newExecScore =
        priorExec !== null && priorExec > VERIFICATION_CAP_SCORE ? VERIFICATION_CAP_SCORE : priorExec;

      // Recompute weighted overall with the capped execution score — reweight
      // over ASSESSED competencies only (RD4), mirroring weightedOverall().
      let weighted = 0;
      let totalWeight = 0;
      for (const it of items) {
        if (it.assessed === false || it.score === null) continue;
        const s = it.competency === "execution" && newExecScore !== null ? newExecScore : Number(it.score);
        weighted += s * Number(it.weight);
        totalWeight += Number(it.weight);
      }
      const overall = totalWeight > 0 ? Math.round((weighted / totalWeight) * 100) / 100 : 0;

      if (execItem && newExecScore !== null && priorExec !== null && newExecScore !== priorExec) {
        const { error: updItemErr } = await supabase
          .from("evaluation_items")
          .update({ score: newExecScore })
          .eq("id", execItem.id as string);
        if (updItemErr) {
          server.log.error({ err: updItemErr, sessionId }, "[review] cap: item update failed");
          return reply.status(500).send({ error: "Failed to apply cap" });
        }
      }
      const { error: updEvalErr } = await supabase
        .from("evaluations")
        .update({ overall_score: overall })
        .eq("id", evalRow.id as string);
      if (updEvalErr) {
        server.log.error({ err: updEvalErr, sessionId }, "[review] cap: overall update failed");
        return reply.status(500).send({ error: "Failed to update overall score" });
      }

      await persistSessionUpdate(sessionId, { verification_cap_status: "confirmed" });
      void appendEvent(sessionId, "verification.cap_confirmed", "system", {
        defense_outcome: sess.defense_outcome,
        execution_score: newExecScore,
        overall_score: overall,
        prior_overall_score: Number(evalRow.overall_score),
      });

      return reply.send({
        verification_cap_status: "confirmed",
        execution_score: newExecScore,
        overall_score: overall,
      });
    },
  );

  // ─── Candidate session links (RD6, Slice 6.7) — admin side ──────────────
  // Issue a single-use, candidate-bound, time-boxed start link. Returns the RAW
  // token once; the browser builds <origin>/?link=<token> (or similar). Same
  // open posture as the rest of /api/review (internal tool).
  const CreateLinkSchema = z.object({
    candidateLabel: z.string().min(1).max(200),
    scenarioId: z.string().uuid().optional(),
    ttlMinutes: z.number().int().positive().max(1440).optional(),
  });
  server.post("/session-links", async (request, reply) => {
    const parse = CreateLinkSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: "Invalid body", details: parse.error.flatten().fieldErrors });
    }
    try {
      const { token, link } = await createSessionLink({
        candidateLabel: parse.data.candidateLabel,
        scenarioId: parse.data.scenarioId ?? null,
        ...(parse.data.ttlMinutes !== undefined ? { ttlMinutes: parse.data.ttlMinutes } : {}),
      });
      return reply.status(201).send({ token, link });
    } catch (err) {
      if (err instanceof SessionLinkError) return reply.status(400).send({ error: err.code, message: err.message });
      server.log.error({ err }, "session-link create failed");
      return reply.status(500).send({ error: "session_link create failed" });
    }
  });

  server.get("/session-links", async (_request, reply) => {
    try {
      return reply.send({ links: await listSessionLinks() });
    } catch (err) {
      server.log.error({ err }, "session-links list failed");
      return reply.status(500).send({ error: "session_links list failed" });
    }
  });

  server.post<{ Params: { id: string } }>("/session-links/:id/revoke", async (request, reply) => {
    const idParse = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!idParse.success) return reply.status(400).send({ error: "Invalid link id" });
    try {
      return reply.send({ link: await revokeSessionLink(idParse.data.id) });
    } catch (err) {
      if (err instanceof SessionLinkError) return reply.status(404).send({ error: err.code, message: err.message });
      server.log.error({ err }, "session-link revoke failed");
      return reply.status(500).send({ error: "session_link revoke failed" });
    }
  });

  // ─── Partner outcome-invite links (admin side) ──────────────────────────
  // Generate a single-use, expiring link for a session that a hiring partner
  // opens (no account) to submit real-world outcomes. Returns the RAW token
  // once; the browser builds <origin>/feedback/<token>. Same open posture as
  // the rest of /api/review (internal tool); the partner side is token-gated.
  server.post<{ Params: { id: string } }>(
    "/sessions/:id/outcome-invite",
    async (request, reply) => {
      const idParse = ParamsSchema.safeParse(request.params);
      if (!idParse.success) return reply.status(400).send({ error: "Invalid session id" });
      const body = (request.body ?? {}) as { outcome_types?: unknown };
      const requested = Array.isArray(body.outcome_types)
        ? body.outcome_types.filter(
            (t): t is (typeof OUTCOME_TYPES)[number] =>
              typeof t === "string" && (OUTCOME_TYPES as readonly string[]).includes(t),
          )
        : undefined;
      try {
        const { token, invite } = await createInvite(
          idParse.data.id,
          requested ? { outcomeTypes: requested } : {},
        );
        return reply.status(201).send({ token, invite });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof OutcomeInviteError && /not found/.test(msg)) {
          return reply.status(404).send({ error: msg });
        }
        server.log.error({ err }, "outcome-invite create failed");
        return reply.status(500).send({ error: "invite create failed", message: msg });
      }
    },
  );

  server.get<{ Params: { id: string } }>(
    "/sessions/:id/outcome-invites",
    async (request, reply) => {
      const idParse = ParamsSchema.safeParse(request.params);
      if (!idParse.success) return reply.status(400).send({ error: "Invalid session id" });
      try {
        const invites = await listInvites(idParse.data.id);
        return reply.send({ invites });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        server.log.error({ err }, "outcome-invites list failed");
        return reply.status(500).send({ error: "invites list failed", message: msg });
      }
    },
  );

  server.post<{ Params: { inviteId: string } }>(
    "/outcome-invites/:inviteId/revoke",
    async (request, reply) => {
      const idParse = z.object({ inviteId: z.string().uuid() }).safeParse(request.params);
      if (!idParse.success) return reply.status(400).send({ error: "Invalid invite id" });
      try {
        const invite = await revokeInvite(idParse.data.inviteId);
        return reply.send({ invite });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof OutcomeInviteError && /not found/.test(msg)) {
          return reply.status(404).send({ error: msg });
        }
        server.log.error({ err }, "outcome-invite revoke failed");
        return reply.status(500).send({ error: "invite revoke failed", message: msg });
      }
    },
  );

  // Captured real-world outcomes for a session (partner-form / webhook / csv) —
  // the review page renders these next to the assessment score so "scored X,
  // real outcome Y" lives in one place.
  server.get<{ Params: { id: string } }>(
    "/sessions/:id/outcomes",
    async (request, reply) => {
      const idParse = ParamsSchema.safeParse(request.params);
      if (!idParse.success) return reply.status(400).send({ error: "Invalid session id" });
      try {
        const outcomes = await listSessionOutcomes(idParse.data.id);
        return reply.send({ outcomes });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        server.log.error({ err }, "session outcomes read failed");
        return reply.status(500).send({ error: "outcomes read failed", message: msg });
      }
    },
  );
}
