// Per-session messaging WebSocket.
//
// Carries BOTH persona channels (client / team) on a single socket so the
// browser only needs one connection. Lifecycle mirrors the PTY route:
// register on open, drop on close, server-initiated close from expireSession.
//
// Inbound  : { channel: "client" | "team", text: string }
// Outbound : { channel, role: "persona", persona_name, text, ts }
//   or     : { type: "error", code, message }

import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { sessionRegistry } from "../services/registry.js";
import { getOrRehydrateSession } from "../services/session-rehydrate.js";
import { enqueueCandidateMessage, type OutboundMessage } from "../services/messaging.js";
import { supabase } from "../services/supabase.js";
import { requireSessionToken, verifyWsToken } from "../services/session-token.js";

const InboundSchema = z.object({
  channel: z.enum(["client", "team"]),
  text: z.string().min(1).max(8000),
});

function safeSend(socket: WebSocket, msg: OutboundMessage): void {
  try {
    if (socket.readyState === 1 /* OPEN */) {
      socket.send(JSON.stringify(msg));
    }
  } catch (err) {
    // Best-effort: socket may already be closing.
    console.warn("[messages] safeSend failed", err);
  }
}

export async function messageRoutes(server: FastifyInstance) {
  server.get<{ Params: { sessionId: string } }>(
    "/messages/:sessionId",
    { websocket: true },
    async (socket, request) => {
      const { sessionId } = request.params;

      // Verify the per-session JWT carried as a WS subprotocol. Browser
      // clients pass `bearer.<token>` in `Sec-WebSocket-Protocol`; a
      // missing or mismatching token closes the socket before we touch
      // the session registry.
      if (!verifyWsToken(request.raw, sessionId)) {
        socket.close(1008, "Unauthorized");
        return;
      }

      const entry = await getOrRehydrateSession(sessionId);

      if (!entry) {
        socket.close(1008, "Session not found");
        return;
      }
      if (entry.status === "completed") {
        socket.close(1008, "Session has ended");
        return;
      }

      // Register so expireSession can close this socket on timeout / budget /
      // manual teardown — same pattern as ptySockets.
      entry.messagingSockets.add(socket);

      socket.on("message", (raw: Buffer) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString("utf8"));
        } catch {
          safeSend(socket, {
            type: "error",
            code: "persona_error",
            message: "Invalid JSON.",
          });
          return;
        }

        const result = InboundSchema.safeParse(parsed);
        if (!result.success) {
          safeSend(socket, {
            type: "error",
            code: "persona_error",
            message: `Invalid message shape: ${result.error.message}`,
          });
          return;
        }

        const { channel, text } = result.data;

        void enqueueCandidateMessage(sessionId, channel, text, (out) =>
          safeSend(socket, out),
        );
      });

      socket.on("close", () => {
        entry.messagingSockets.delete(socket);
      });
    },
  );

  // ─── History fetch — used by the workspace to hydrate on mount/refresh ──
  //
  // Returns the persisted persona+candidate messages for this session, both
  // channels, in chronological order. Shape matches the WS Outbound payload
  // so the client can union the historical batch with live WS pushes
  // directly. Chat lives in the events table — type LIKE 'message.%' with
  // payload.text — so this is a single grouped read.
  server.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/messages",
    {
      preHandler: [requireSessionToken((req) => (req.params as { sessionId?: string }).sessionId)],
    },
    async (request, reply) => {
      const { sessionId } = request.params;
      if (!supabase) {
        return reply.status(503).send({ error: "Supabase unavailable" });
      }
      const { data, error } = await supabase
        .from("events")
        .select("type, ts, payload, seq")
        .eq("session_id", sessionId)
        .like("type", "message.%")
        .order("seq", { ascending: true })
        .range(0, 9_999); // generous cap; supabase-js defaults cap silently
      if (error) {
        return reply.status(500).send({ error: "history fetch failed", message: error.message });
      }

      interface EventRow {
        type: string;
        ts: string;
        payload: { text?: string; persona_name?: string };
      }
      const rows = (data ?? []) as EventRow[];
      const messages = rows
        .map((r) => {
          // type shape: `message.${channel}.${role}` — e.g. message.client.candidate
          const parts = r.type.split(".");
          if (parts.length !== 3) return null;
          const channel = parts[1];
          const role = parts[2];
          if (channel !== "client" && channel !== "team") return null;
          if (role !== "candidate" && role !== "persona") return null;
          const text = r.payload?.text;
          if (typeof text !== "string") return null;
          return {
            channel,
            role,
            persona_name: role === "persona" ? r.payload.persona_name ?? null : null,
            text,
            ts: r.ts,
          };
        })
        .filter((m): m is NonNullable<typeof m> => m !== null);
      return reply.send({ messages });
    },
  );
}
