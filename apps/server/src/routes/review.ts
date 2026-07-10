// Recruiter review endpoints — READ-ONLY from Supabase.
// These power the post-session review UI. They MUST work for ended sessions
// no longer in the in-memory registry, so all data comes from Supabase via
// the server-only service-role client. Browser never queries Supabase directly.
//
// P2 TENANT AUTH: every route in this plugin runs behind requireOrg — a valid
// X-Org-Key header resolves the calling org; with ORG_AUTH_REQUIRED off (the
// rollout default) a key-less request falls back to the default 'asaya' admin
// org so the existing review UI keeps working. Every session-shaped query is
// then scoped to the caller's org (role 'admin' sees all); foreign sessions
// read as 404 so existence never leaks across tenants. The service role
// bypasses RLS, so THIS app-layer scoping is the isolation mechanism (the
// deny-all RLS posture is the DB backstop — see migration 0019).
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { supabase } from "../services/supabase.js";
import {
  requireOrg,
  orgCanAccess,
  scopeToOrg,
  type OrgRow,
} from "../services/orgs.js";
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
// P5.1/P5.3 — difficulty routing band + equating hook.
import { DIFFICULTY_BANDS } from "../services/difficulty-routing.js";
import { checkBandEquating } from "../services/equating.js";
import { DIFFICULTY_STATS_VERSION } from "../services/difficulty-stats.js";
import { appendEvent } from "../services/events-direct.js";
import { VERIFICATION_CAP_SCORE } from "../services/defense.js";
import {
  computeSuspicionScore,
  computeNetworkSummary,
  type SuspicionEventInput,
} from "../services/suspicion-score.js";
import { readIdentityStatus } from "../services/proctoring-v2.js";
import { buildCohort, CohortError } from "../services/cohort.js";
import {
  createReportShare,
  listReportShares,
  revokeReportShare,
  ReportShareError,
  MAX_SHARE_TTL_HOURS,
} from "../services/report-share.js";
import {
  readLiveStatus,
  readEventsSince,
  statusChanged,
  isTerminalStatus,
  LIVE_POLL_INTERVAL_MS,
  LIVE_HEARTBEAT_MS,
  type LiveStatusSnapshot,
} from "../services/live-stream.js";

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
  scenario_id: string | null;
  // P5.1: band the session was routed to at creation (migration 0020).
  // Absent on a pre-0020 database — see the band-column fallback in the list.
  difficulty_band?: string | null;
}

// ── P5.1: sessions.difficulty_band may not exist yet (0020 unapplied) ───────
// The list selects it optimistically; the first 42703 flips this latch and the
// query retries (and keeps running) without the column.
const SESSION_LIST_COLS =
  "id, status, end_reason, model, created_at, ended_at, duration_ms, spend_usd, scenario_id";
let listBandColumnMissing = false;

export async function reviewRoutes(server: FastifyInstance) {
  if (!supabase) {
    server.log.warn("[review] supabase client unavailable — /api/review routes will 503");
  }

  // P2: org auth on EVERY /api/review route (see module header).
  server.addHook("preHandler", requireOrg);

  /** Tenant gate for session-scoped endpoints: does the caller's org own this
   *  session (admin sees all)? Foreign/missing sessions are indistinguishable
   *  ("not_found") so a partner can't probe another org's session ids.
   *  On "ok" the SESSION's org_id rides along so writes derived from the
   *  session (e.g. outcome invites) can be stamped with the owning tenant
   *  rather than the requesting org — an admin acting on a partner's session
   *  must not pull the artifact into the admin org. */
  type OrgGateResult =
    | { status: "ok"; sessionOrgId: string | null }
    | { status: "not_found" }
    | { status: "error" };
  async function sessionOrgGate(
    sessionId: string,
    org: OrgRow | undefined,
  ): Promise<OrgGateResult> {
    if (!supabase) return { status: "error" };
    const { data, error } = await supabase
      .from("sessions")
      .select("id, org_id")
      .eq("id", sessionId)
      .maybeSingle();
    if (error) return { status: "error" };
    if (!data) return { status: "not_found" };
    const sessionOrgId = (data as { org_id: string | null }).org_id;
    return orgCanAccess(org, sessionOrgId)
      ? { status: "ok", sessionOrgId }
      : { status: "not_found" };
  }

  // ─── List ────────────────────────────────────────────────────────────────
  server.get("/sessions", async (request, reply) => {
    if (!supabase) {
      return reply.status(503).send({ error: "Supabase unavailable" });
    }

    // P2: partner orgs list only their own sessions; admin (asaya) sees all.
    // P5.1: difficulty_band rides along when migration 0020 is applied; on the
    // first missing-column error the query retries without it (band → null).
    const listSessions = async (withBand: boolean) => {
      const res = await scopeToOrg(
        supabase!
          .from("sessions")
          .select(withBand ? `${SESSION_LIST_COLS}, difficulty_band` : SESSION_LIST_COLS),
        request.org,
      )
        .order("created_at", { ascending: false })
        .limit(LIST_LIMIT);
      // Dynamic select string defeats supabase-js's literal-type parser —
      // the projection above is what defines the runtime shape.
      return { data: res.data as unknown as SessionRow[] | null, error: res.error };
    };

    let listRes = await listSessions(!listBandColumnMissing);
    if (
      listRes.error &&
      !listBandColumnMissing &&
      listRes.error.code === "42703" &&
      /difficulty_band/i.test(listRes.error.message)
    ) {
      listBandColumnMissing = true;
      server.log.warn(
        "[review] sessions.difficulty_band missing (migration 0020 not applied) — listing without band",
      );
      listRes = await listSessions(false);
    }
    const { data: sessions, error: sessErr } = listRes;

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
    // Scenario titles for the cohort links (P4.1) — distinct ids only, so
    // this stays a handful of rows regardless of session count.
    const scenarioIds = [
      ...new Set((sessions as SessionRow[]).map((s) => s.scenario_id).filter((x): x is string => !!x)),
    ];

    const [countsRes, evalsRes, scenariosRes] = await Promise.all([
      supabase.rpc("review_session_counts", { ids }),
      supabase.rpc("review_latest_evaluations", { ids }),
      scenarioIds.length > 0
        ? supabase.from("scenarios").select("id, title").in("id", scenarioIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    for (const res of [countsRes, evalsRes, scenariosRes]) {
      if (res.error) {
        server.log.error({ err: res.error }, "[review] count query failed");
        return reply.status(500).send({ error: "Failed to load session counts" });
      }
    }

    const scenarioTitles = new Map<string, string>();
    for (const s of (scenariosRes.data ?? []) as Array<{ id: string; title: string }>) {
      scenarioTitles.set(s.id, s.title);
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
        scenario_id: s.scenario_id,
        scenario_title: s.scenario_id ? (scenarioTitles.get(s.scenario_id) ?? null) : null,
        // P5.1: effective band the session ran at (null pre-routing/pre-0020).
        difficulty_band: s.difficulty_band ?? null,
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
    // P2: a foreign org's session is a 404, not a 403 — no existence leak.
    if (
      !sessRes.data ||
      !orgCanAccess(request.org, (sessRes.data as { org_id?: string | null }).org_id)
    ) {
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

  // ─── Suspicion score (P1 — proctoring v1, informational) ────────────────
  // Recomputes the deterministic suspicion score on demand from the session's
  // integrity.* events and returns it with the raw integrity timeline. This
  // channel is INFORMATIONAL ONLY — it never touches evidence/evaluations
  // (isolation enforced in evidence-extractor / analysis-input). Additive:
  // no existing review endpoint changes.
  server.get<{ Params: { id: string } }>(
    "/sessions/:id/suspicion",
    async (request, reply) => {
      const idParse = ParamsSchema.safeParse(request.params);
      if (!idParse.success) {
        return reply.status(400).send({ error: "Invalid session id (must be uuid)" });
      }
      if (!supabase) {
        return reply.status(503).send({ error: "Supabase unavailable" });
      }
      const id = idParse.data.id;

      const [sessRes, eventsRes] = await Promise.all([
        supabase.from("sessions").select("id, org_id").eq("id", id).maybeSingle(),
        supabase
          .from("events")
          .select("seq, type, ts, payload")
          .eq("session_id", id)
          // P6: identity.* (consent / verification) rides the same
          // informational timeline as integrity.*. PostgREST `or` uses `*`
          // as the like-wildcard. computeSuspicionScore ignores identity.*
          // (it filters on the integrity. prefix), so the score is unchanged.
          .or("type.like.integrity.*,type.like.identity.*")
          .order("seq", { ascending: true })
          .limit(1000),
      ]);

      if (sessRes.error) {
        server.log.error({ err: sessRes.error, id }, "[review] suspicion: session lookup failed");
        return reply.status(500).send({ error: "Failed to load session" });
      }
      if (
        !sessRes.data ||
        !orgCanAccess(request.org, (sessRes.data as { org_id?: string | null }).org_id)
      ) {
        return reply.status(404).send({ error: "Session not found" });
      }
      if (eventsRes.error) {
        server.log.error({ err: eventsRes.error, id }, "[review] suspicion: events load failed");
        return reply.status(500).send({ error: "Failed to load integrity events" });
      }

      const events = (eventsRes.data ?? []) as unknown as SuspicionEventInput[];
      return reply.send({
        suspicion: computeSuspicionScore(events),
        events,
        // Explicit .limit(1000) above — at exactly 1000 rows the timeline (and
        // therefore the recomputed score) may be missing later events.
        truncated: events.length === 1000,
        // P6 identity status (recruiter-only, informational) — null for every
        // v1 session and pre-0024 deploys; the web SuspicionPanel renders the
        // identity row only when non-null. RECRUITER-ONLY like the factor
        // breakdown: this block must never reach the public shared report
        // (services/shared-report.ts allowlist).
        identity: await readIdentityStatus(id),
        // Geo/network slice (recruiter-only, informational — mirrors the
        // identity block's posture exactly): coarse location at start,
        // ip-change count, distinct countries, tz-mismatch flag. Derived from
        // the integrity.* rows already loaded above; null for every session
        // that predates the slice, so older sessions render no network row.
        // Must NEVER reach the public shared report (allowlist has no
        // network field; verify-geo-integrity.ts asserts it).
        network: computeNetworkSummary(events),
      });
    },
  );

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
      // P2: only the owning org (or admin) may trigger an evaluation.
      const gate = await sessionOrgGate(sessionId, request.org);
      if (gate.status === "error") return reply.status(500).send({ error: "Failed to load session" });
      if (gate.status === "not_found") return reply.status(404).send({ error: "Session not found" });
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
      // P2: only the owning org (or admin) may re-judge stored evidence.
      const gate = await sessionOrgGate(sessionId, request.org);
      if (gate.status === "error") return reply.status(500).send({ error: "Failed to load session" });
      if (gate.status === "not_found") return reply.status(404).send({ error: "Session not found" });
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
        .select("id, verification_cap_status, defense_outcome, org_id")
        .eq("id", sessionId)
        .maybeSingle();
      if (sessErr) {
        server.log.error({ err: sessErr, sessionId }, "[review] cap: session lookup failed");
        return reply.status(500).send({ error: "Failed to load session" });
      }
      // P2: foreign org's session → 404 (no existence leak).
      if (!sess || !orgCanAccess(request.org, (sess as { org_id?: string | null }).org_id)) {
        return reply.status(404).send({ error: "Session not found" });
      }
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
    // P5.1: requested difficulty band (manual per-invite banding). Omitted /
    // null = no routing — the scenario starts exactly as published.
    difficultyBand: z.enum(DIFFICULTY_BANDS).nullish(),
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
        // P2: the link belongs to the REQUESTING org; the session started from
        // it inherits this org_id (routes/sessions.ts).
        orgId: request.org?.id ?? null,
        // P5.1: band consumed once, at session creation (difficulty routing).
        difficultyBand: parse.data.difficultyBand ?? null,
      });
      return reply.status(201).send({ token, link });
    } catch (err) {
      if (err instanceof SessionLinkError) return reply.status(400).send({ error: err.code, message: err.message });
      server.log.error({ err }, "session-link create failed");
      return reply.status(500).send({ error: "session_link create failed" });
    }
  });

  server.get("/session-links", async (request, reply) => {
    try {
      return reply.send({ links: await listSessionLinks(request.org) });
    } catch (err) {
      server.log.error({ err }, "session-links list failed");
      return reply.status(500).send({ error: "session_links list failed" });
    }
  });

  server.post<{ Params: { id: string } }>("/session-links/:id/revoke", async (request, reply) => {
    const idParse = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!idParse.success) return reply.status(400).send({ error: "Invalid link id" });
    try {
      return reply.send({ link: await revokeSessionLink(idParse.data.id, request.org) });
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
      // P2: only the owning org (or admin) may mint an invite for a session;
      // the invite carries the SESSION's org (not the requesting org) so
      // partner_form outcomes inherit the owning tenant — an admin minting an
      // invite for a partner's session must not pull it into the admin org.
      const gate = await sessionOrgGate(idParse.data.id, request.org);
      if (gate.status === "error") return reply.status(500).send({ error: "Failed to load session" });
      if (gate.status === "not_found") return reply.status(404).send({ error: "Session not found" });
      try {
        const { token, invite } = await createInvite(idParse.data.id, {
          ...(requested ? { outcomeTypes: requested } : {}),
          orgId: gate.sessionOrgId ?? request.org?.id ?? null,
        });
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
      const gate = await sessionOrgGate(idParse.data.id, request.org);
      if (gate.status === "error") return reply.status(500).send({ error: "Failed to load session" });
      if (gate.status === "not_found") return reply.status(404).send({ error: "Session not found" });
      try {
        const invites = await listInvites(idParse.data.id, request.org);
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
        // P2: revokeInvite is org-scoped — a foreign invite reads as not found.
        const invite = await revokeInvite(idParse.data.inviteId, request.org);
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
      const gate = await sessionOrgGate(idParse.data.id, request.org);
      if (gate.status === "error") return reply.status(500).send({ error: "Failed to load session" });
      if (gate.status === "not_found") return reply.status(404).send({ error: "Session not found" });
      try {
        // P2: partner orgs see only outcomes stamped with their org.
        const outcomes = await listSessionOutcomes(idParse.data.id, request.org);
        return reply.send({ outcomes });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        server.log.error({ err }, "session outcomes read failed");
        return reply.status(500).send({ error: "outcomes read failed", message: msg });
      }
    },
  );

  // ─── Cohort dashboard (P4.1) ──────────────────────────────────────────────
  // All sessions routed to one scenario, ranked by overall score, with
  // per-competency cells, scorable/exclusion status, difficulty band,
  // AI-Fluency placement, and the informational suspicion score. Org-scoped
  // like everything else here (partner = own sessions; admin = all); the
  // assembly lives in services/cohort.ts so verify-cohort-dashboard.ts can
  // exercise it without HTTP.
  server.get<{ Params: { scenarioId: string } }>(
    "/cohorts/:scenarioId",
    async (request, reply) => {
      const idParse = z.object({ scenarioId: z.string().uuid() }).safeParse(request.params);
      if (!idParse.success) {
        return reply.status(400).send({ error: "Invalid scenario id (must be uuid)" });
      }
      if (!supabase) return reply.status(503).send({ error: "Supabase unavailable" });
      try {
        const cohort = await buildCohort(idParse.data.scenarioId, request.org);
        if (!cohort) return reply.status(404).send({ error: "Scenario not found" });
        return reply.send(cohort);
      } catch (err) {
        if (err instanceof CohortError) {
          server.log.error({ err }, "[review] cohort build failed");
          return reply.status(500).send({ error: "Failed to build cohort" });
        }
        throw err;
      }
    },
  );

  // ─── Shareable report links (P4.3) ────────────────────────────────────────
  // Mint / list / revoke report_shares for a session. The RAW token is
  // returned exactly once at mint; the browser builds <site origin>/report/
  // <token>. The public consumer is GET /api/report/:token (routes/report.ts
  // — token-gated, NOT behind this plugin's org auth).
  const ShareBodySchema = z.object({
    ttlHours: z.number().int().positive().max(MAX_SHARE_TTL_HOURS).optional(),
  });
  server.post<{ Params: { id: string } }>("/sessions/:id/share", async (request, reply) => {
    const idParse = ParamsSchema.safeParse(request.params);
    if (!idParse.success) return reply.status(400).send({ error: "Invalid session id" });
    const bodyParse = ShareBodySchema.safeParse(request.body ?? {});
    if (!bodyParse.success) {
      return reply
        .status(400)
        .send({ error: "Invalid body", details: bodyParse.error.flatten().fieldErrors });
    }
    // P2: only the owning org (or admin) may share a session's report. The
    // share is stamped with the SESSION's org — an admin sharing a partner's
    // session must not pull the artifact into the admin org.
    const gate = await sessionOrgGate(idParse.data.id, request.org);
    if (gate.status === "error") return reply.status(500).send({ error: "Failed to load session" });
    if (gate.status === "not_found") return reply.status(404).send({ error: "Session not found" });
    try {
      const { token, share } = await createReportShare({
        sessionId: idParse.data.id,
        orgId: gate.sessionOrgId ?? request.org?.id ?? null,
        ...(bodyParse.data.ttlHours !== undefined ? { ttlHours: bodyParse.data.ttlHours } : {}),
      });
      return reply.status(201).send({ token, share });
    } catch (err) {
      if (err instanceof ReportShareError && err.code === "invalid") {
        return reply.status(400).send({ error: err.code, message: err.message });
      }
      server.log.error({ err }, "report-share create failed");
      return reply.status(500).send({ error: "report_share create failed" });
    }
  });

  server.get<{ Params: { id: string } }>("/sessions/:id/shares", async (request, reply) => {
    const idParse = ParamsSchema.safeParse(request.params);
    if (!idParse.success) return reply.status(400).send({ error: "Invalid session id" });
    const gate = await sessionOrgGate(idParse.data.id, request.org);
    if (gate.status === "error") return reply.status(500).send({ error: "Failed to load session" });
    if (gate.status === "not_found") return reply.status(404).send({ error: "Session not found" });
    try {
      return reply.send({ shares: await listReportShares(idParse.data.id, request.org) });
    } catch (err) {
      server.log.error({ err }, "report-shares list failed");
      return reply.status(500).send({ error: "report_shares list failed" });
    }
  });

  server.post<{ Params: { id: string } }>("/report-shares/:id/revoke", async (request, reply) => {
    const idParse = ParamsSchema.safeParse(request.params);
    if (!idParse.success) return reply.status(400).send({ error: "Invalid share id" });
    try {
      // Org-scoped inside the service — a foreign org's share reads as 404.
      return reply.send({ share: await revokeReportShare(idParse.data.id, request.org) });
    } catch (err) {
      if (err instanceof ReportShareError && err.code === "not_found") {
        return reply.status(404).send({ error: err.code, message: err.message });
      }
      server.log.error({ err }, "report-share revoke failed");
      return reply.status(500).send({ error: "report_share revoke failed" });
    }
  });

  // ─── P5.3: band equating check (ADMIN ONLY, read-only) ───────────────────
  // Are band-matched members of a scenario family on the same score scale?
  // Compares mean_score per competency across family members that share a
  // band, over competency_difficulty_stats rows with n >= 5 (services/
  // equating.ts). Calibration internals — partner orgs get a 403; scenarios
  // are global asaya IP, so there is nothing org-scoped to leak-protect
  // beyond hiding it from partners entirely.
  server.get<{ Params: { familyId: string } }>("/equating/:familyId", async (request, reply) => {
    if (request.org && request.org.role !== "admin") {
      return reply.status(403).send({ error: "admin_only", message: "Equating is an internal calibration surface." });
    }
    const familyId = (request.params.familyId ?? "").trim();
    if (!familyId || familyId.length > 200) {
      return reply.status(400).send({ error: "Invalid family id" });
    }
    if (!supabase) return reply.status(503).send({ error: "Supabase unavailable" });
    try {
      const comparisons = await checkBandEquating(familyId);
      return reply.send({
        family: familyId,
        stats_version: DIFFICULTY_STATS_VERSION,
        comparisons,
      });
    } catch (err) {
      server.log.error({ err, familyId }, "[review] equating check failed");
      return reply.status(500).send({ error: "equating check failed" });
    }
  });

  // ─── Live session monitoring (SSE, READ-ONLY) ───────────────────────────────
  // GET /api/review/sessions/:id/live — a Server-Sent Events feed a recruiter/
  // admin watches while a session is in progress. Behind requireOrg (plugin
  // preHandler); a foreign session reads as 404 (no existence leak), matching
  // sessionOrgGate everywhere else. There is NO event bus on the registry, so
  // this POLLS the events table (seq tail) + the sessions row every ~1s.
  //
  // ORG KEY OVER THE HEADER: the browser can't set X-Org-Key on an EventSource,
  // so the web client uses a fetch()+ReadableStream reader and keeps the key in
  // the X-Org-Key header (never a query param / URL — no key in logs). Nothing
  // special is needed here: requireOrg reads the header as on every other
  // /api/review route.
  //
  // Emits:
  //   event: status  {status, spend_usd, budget_usd, deadline, ended_at} — on
  //                   connect + whenever any field changes.
  //   event: events  {events:[{seq,type,actor,payload,created_at}]} — new rows
  //                   with seq > lastSeq, ascending, capped batch.
  //   event: end     {reason} — once the session is terminal; then close.
  //
  // ?since=<seq> (default 0) lets the client catch up then follow. Total stream
  // lifetime is capped defensively (deadline + grace) so a wedged client can't
  // hold a poll loop open forever.
  const LiveQuerySchema = z.object({
    since: z.coerce.number().int().min(0).optional(),
  });
  const LIVE_STREAM_GRACE_MS = 5 * 60_000; // auto-close this long past the deadline
  const LIVE_MAX_LIFETIME_MS = 4 * 60 * 60_000; // absolute ceiling (4h) if no deadline

  server.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    "/sessions/:id/live",
    async (request, reply) => {
      const idParse = ParamsSchema.safeParse(request.params);
      if (!idParse.success) {
        return reply.status(400).send({ error: "Invalid session id (must be uuid)" });
      }
      const qParse = LiveQuerySchema.safeParse(request.query);
      if (!qParse.success) {
        return reply.status(400).send({ error: "Invalid ?since (must be a non-negative integer)" });
      }
      if (!supabase) {
        return reply.status(503).send({ error: "Supabase unavailable" });
      }
      const sessionId = idParse.data.id;

      // P2 tenant gate — foreign/missing session → 404 (no existence leak),
      // identical to sessionOrgGate semantics used across this plugin.
      const gate = await sessionOrgGate(sessionId, request.org);
      if (gate.status === "error") return reply.status(500).send({ error: "Failed to load session" });
      if (gate.status === "not_found") return reply.status(404).send({ error: "Session not found" });

      // Take over the socket: we write the raw SSE stream ourselves.
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // Disable proxy buffering (nginx / Railway edge) so events flush live.
        "X-Accel-Buffering": "no",
      });

      // Resume point. Per-session seq is 0-indexed (first event is seq 0), and
      // the tail query is strict `seq > lastSeq`. So an ABSENT ?since means
      // "from the very beginning" — start at -1 so seq 0 is included. An
      // EXPLICIT ?since=N keeps strict "give me only what's after N" semantics
      // (?since=0 → skip seq 0, resume after it).
      let lastSeq = qParse.data.since ?? -1;
      let lastStatus: LiveStatusSnapshot | null = null;
      let closed = false;
      let polling = false;
      // Assigned once the loop/ceiling are armed; cleanup() clears whichever
      // are set, so an early terminal close (before arming) is safe.
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      let lifetimeTimer: ReturnType<typeof setTimeout> | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      const send = (event: string, data: unknown): boolean => {
        if (closed || raw.writableEnded) return false;
        try {
          raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          return true;
        } catch {
          return false;
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (pollTimer !== null) clearInterval(pollTimer);
        if (lifetimeTimer !== null) clearTimeout(lifetimeTimer);
        if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
        if (!raw.writableEnded) {
          try { raw.end(); } catch { /* already gone */ }
        }
      };

      const finish = (reason: string) => {
        send("end", { reason });
        cleanup();
      };

      // Stop the loop the moment the client goes away.
      request.raw.on("close", cleanup);
      raw.on("close", cleanup);
      raw.on("error", cleanup);

      const poll = async () => {
        if (closed || polling) return; // never overlap ticks
        polling = true;
        try {
          const snap = await readLiveStatus(sessionId);
          if (closed) return;
          if (snap === null) {
            // Row vanished (deleted mid-stream) — end gracefully.
            finish("gone");
            return;
          }
          if (statusChanged(lastStatus, snap)) {
            lastStatus = snap;
            send("status", snap);
          }

          const rows = await readEventsSince(sessionId, lastSeq);
          if (closed) return;
          if (rows.length > 0) {
            lastSeq = rows[rows.length - 1]!.seq;
            send("events", { events: rows });
          }

          // Terminal → drain once more (done above) then end. Only stop when
          // the batch was NOT full, so a completed session with a big event
          // backlog is fully delivered before "end".
          if (isTerminalStatus(snap.status) && rows.length === 0) {
            finish(snap.status ?? "completed");
          }
        } catch (err) {
          server.log.error({ err, sessionId }, "[review] live poll failed");
          // Transient DB blip — keep the loop alive; the client also
          // reconnects-from-last-seq on a dropped stream.
        } finally {
          polling = false;
        }
      };

      // Defensive lifetime ceiling: deadline + grace, else a hard 4h cap.
      const initialSnap = await readLiveStatus(sessionId);
      if (closed) return; // client already left during the gate/read
      let lifetimeMs = LIVE_MAX_LIFETIME_MS;
      const deadlineMs = initialSnap?.deadline ? Date.parse(initialSnap.deadline) : NaN;
      if (!Number.isNaN(deadlineMs)) {
        const untilDeadline = deadlineMs - Date.now() + LIVE_STREAM_GRACE_MS;
        lifetimeMs = Math.max(LIVE_POLL_INTERVAL_MS, Math.min(LIVE_MAX_LIFETIME_MS, untilDeadline));
      }
      lifetimeTimer = setTimeout(() => finish("timeout"), lifetimeMs);

      // Prime the connection with the current status immediately, then follow.
      if (initialSnap) {
        lastStatus = initialSnap;
        send("status", initialSnap);
        if (isTerminalStatus(initialSnap.status)) {
          // Already ended: catch the client up on any tail then close.
          const rows = await readEventsSince(sessionId, lastSeq);
          if (rows.length > 0) {
            lastSeq = rows[rows.length - 1]!.seq;
            send("events", { events: rows });
          }
          finish(initialSnap.status ?? "completed");
          return;
        }
      }

      pollTimer = setInterval(() => void poll(), LIVE_POLL_INTERVAL_MS);
      // First tail fetch right away (don't wait a full interval for backlog).
      void poll();

      // SSE heartbeat: the poll only WRITES on a status/event change, so an
      // active session with nothing happening is silent — and Railway's edge
      // (and most proxies) reap an idle streaming response after ~30-60s,
      // which surfaced as the client looping on "reconnecting". A comment line
      // (":" prefix, ignored by the SSE parser) every 15s keeps the pipe warm
      // without emitting spurious frames.
      heartbeatTimer = setInterval(() => {
        if (closed || raw.writableEnded) return;
        try { raw.write(`: hb ${Date.now()}\n\n`); } catch { cleanup(); }
      }, LIVE_HEARTBEAT_MS);
    },
  );
}
