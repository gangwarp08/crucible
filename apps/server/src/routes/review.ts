// Recruiter review endpoints — READ-ONLY from Supabase.
// These power the post-session review UI. They MUST work for ended sessions
// no longer in the in-memory registry, so all data comes from Supabase via
// the server-only service-role client. Browser never queries Supabase directly.
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { supabase } from "../services/supabase.js";
import { runAnalysisAgent, AnalysisError } from "../services/analysis-agent.js";

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

function countBySessionId(rows: Array<{ session_id: string }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.session_id, (out.get(r.session_id) ?? 0) + 1);
  return out;
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

    // One grouped query per child table, fired in parallel.
    // We fetch only session_id and aggregate in JS — avoids the N+1 trap and
    // doesn't require an RPC. For 100 sessions this is at most a few hundred
    // rows per child query. Evaluations is the fourth parallel read: we want
    // the LATEST per session (re-runs delete-then-insert but defence in depth
    // against any stray duplicates — keep most-recent created_at per session).
    const [eventsRes, msgsRes, filesRes, evalsRes] = await Promise.all([
      supabase.from("events").select("session_id").in("session_id", ids),
      supabase
        .from("transcript")
        .select("session_id")
        .in("session_id", ids)
        .neq("role", "system"),
      supabase.from("file_snapshots").select("session_id").in("session_id", ids),
      supabase
        .from("evaluations")
        .select("session_id, overall_score, status, created_at")
        .in("session_id", ids)
        .order("created_at", { ascending: false }),
    ]);

    for (const res of [eventsRes, msgsRes, filesRes, evalsRes]) {
      if (res.error) {
        server.log.error({ err: res.error }, "[review] count query failed");
        return reply.status(500).send({ error: "Failed to load session counts" });
      }
    }

    const eventCounts = countBySessionId(eventsRes.data ?? []);
    const msgCounts   = countBySessionId(msgsRes.data ?? []);
    const fileCounts  = countBySessionId(filesRes.data ?? []);

    // Build latest-evaluation-per-session map. Rows arrived sorted by
    // created_at DESC so the first row we see for a given session_id wins.
    interface EvalListRow {
      session_id: string;
      overall_score: number | string;
      status: string;
      created_at: string;
    }
    const latestEval = new Map<string, EvalListRow>();
    for (const r of (evalsRes.data ?? []) as EvalListRow[]) {
      if (!latestEval.has(r.session_id)) latestEval.set(r.session_id, r);
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
        .select("competency, score, weight, rationale, evidence, created_at")
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
}
