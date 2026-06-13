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
}
