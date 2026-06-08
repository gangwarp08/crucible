// Recruiter review endpoints — READ-ONLY from Supabase.
// These power the post-session review UI. They MUST work for ended sessions
// no longer in the in-memory registry, so all data comes from Supabase via
// the server-only service-role client. Browser never queries Supabase directly.
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { supabase } from "../services/supabase.js";

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
    // rows per child query.
    const [eventsRes, msgsRes, filesRes] = await Promise.all([
      supabase.from("events").select("session_id").in("session_id", ids),
      supabase
        .from("transcript")
        .select("session_id")
        .in("session_id", ids)
        .neq("role", "system"),
      supabase.from("file_snapshots").select("session_id").in("session_id", ids),
    ]);

    for (const res of [eventsRes, msgsRes, filesRes]) {
      if (res.error) {
        server.log.error({ err: res.error }, "[review] count query failed");
        return reply.status(500).send({ error: "Failed to load session counts" });
      }
    }

    const eventCounts = countBySessionId(eventsRes.data ?? []);
    const msgCounts   = countBySessionId(msgsRes.data ?? []);
    const fileCounts  = countBySessionId(filesRes.data ?? []);

    const rows = (sessions as SessionRow[]).map((s) => ({
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
    }));

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

    // Fire all five reads in parallel — they share no dependencies.
    // file_snapshots has no seq column, so we order it by ts (insertion order).
    const [sessRes, eventsRes, transcriptRes, fileSnapshotsRes, costRes] =
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
      ]);

    if (sessRes.error) {
      server.log.error({ err: sessRes.error, id }, "[review] session lookup failed");
      return reply.status(500).send({ error: "Failed to load session" });
    }
    if (!sessRes.data) {
      return reply.status(404).send({ error: "Session not found" });
    }

    for (const res of [eventsRes, transcriptRes, fileSnapshotsRes, costRes]) {
      if (res.error) {
        server.log.error({ err: res.error, id }, "[review] detail child query failed");
        return reply.status(500).send({ error: "Failed to load session detail" });
      }
    }

    return reply.send({
      session:       sessRes.data,
      events:        eventsRes.data ?? [],
      transcript:    transcriptRes.data ?? [],
      fileSnapshots: fileSnapshotsRes.data ?? [],
      cost:          costRes.data ?? [],
    });
  });
}
