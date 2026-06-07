import type { FastifyInstance } from "fastify";
import type { CommandHandle } from "e2b";
import { sessionRegistry } from "../services/registry.js";
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

      let ptyHandle: CommandHandle | undefined;

      try {
        ptyHandle = await entry.sandbox.pty.create({
          cols: 80,
          rows: 24,
          cwd: "/workspace",
          timeoutMs: env.SESSION_TIMEOUT_MIN * 60_000,
          onData: (data: Uint8Array) => {
            if (socket.readyState === 1 /* OPEN */) {
              socket.send(Buffer.from(data));
            }
          },
        });
      } catch (err) {
        server.log.error({ err, sessionId }, "PTY creation failed");
        socket.close(1011, "PTY creation failed");
        return;
      }

      socket.on("message", (msg: Buffer) => {
        if (ptyHandle !== undefined) {
          entry.sandbox.pty
            .sendInput(ptyHandle.pid, new Uint8Array(msg))
            .catch((err) => server.log.error({ err }, "pty.sendInput failed"));
        }
      });

      // On close: kill the PTY only; leave the sandbox running for reconnect
      socket.on("close", () => {
        if (ptyHandle !== undefined) {
          entry.sandbox.pty.kill(ptyHandle.pid).catch(() => {});
        }
      });
    }
  );
}
