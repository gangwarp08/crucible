import type { FastifyInstance } from "fastify";
import type { CommandHandle } from "e2b";
import { sessionRegistry } from "../services/registry.js";
import { appendPtyData, flushAllPtyBuffers } from "../services/telemetry.js";
import { env } from "../env.js";

export async function ptyRoutes(server: FastifyInstance) {
  server.get<{ Params: { sessionId: string } }>(
    "/pty/:sessionId",
    { websocket: true },
    async (socket, request) => {
      const { sessionId } = request.params;
      const entry = sessionRegistry.get(sessionId);

      if (!entry) {
        socket.close(1008, "Session not found");
        return;
      }
      if (entry.status === "completed") {
        socket.close(1008, "Session has ended");
        return;
      }

      // Register so expireSession can close this socket on timeout.
      entry.ptySockets.add(socket);

      let ptyHandle: CommandHandle | undefined;

      try {
        ptyHandle = await entry.sandbox.pty.create({
          cols: 80,
          rows: 24,
          cwd: "/workspace",
          timeoutMs: env.SESSION_TIMEOUT_MIN * 60_000,
          onData: (data: Uint8Array) => {
            const buf = Buffer.from(data);
            if (socket.readyState === 1 /* OPEN */) socket.send(buf);
            appendPtyData(sessionId, "output", buf);
          },
        });
      } catch (err) {
        server.log.error({ err, sessionId }, "PTY creation failed");
        entry.ptySockets.delete(socket);
        socket.close(1011, "PTY creation failed");
        return;
      }

      socket.on("message", (msg: Buffer) => {
        appendPtyData(sessionId, "input", msg);
        if (ptyHandle !== undefined) {
          entry.sandbox.pty
            .sendInput(ptyHandle.pid, new Uint8Array(msg))
            .catch((err) => server.log.error({ err }, "pty.sendInput failed"));
        }
      });

      socket.on("close", () => {
        entry.ptySockets.delete(socket);
        flushAllPtyBuffers(sessionId); // drain remaining bytes before the session may end
        if (ptyHandle !== undefined) {
          entry.sandbox.pty.kill(ptyHandle.pid).catch(() => {});
        }
      });
    },
  );
}
