import type { FastifyInstance } from "fastify";
import type { CommandHandle } from "e2b";
import { sessionRegistry } from "../services/registry.js";
import { getOrRehydrateSession } from "../services/session-rehydrate.js";
import { verifyWsToken } from "../services/session-token.js";
import { appendPtyData, flushAllPtyBuffers } from "../services/telemetry.js";
import { deductComputeMinutes } from "../services/compute-tracker.js";
import { isWritable } from "../services/guards.js";
import { env } from "../env.js";

// xterm sends `\r` (0x0d, carriage return) on Enter — we treat every \r in a
// PTY input chunk as one "command" attempt for the compute mechanic. Edge
// cases: pasted multi-line text is charged per line (correct — N commands);
// holding Enter at an empty prompt is charged per press (correct — N empty
// runs); backspaces / arrow keys / Ctrl-C do not contain \r and are free.
const CR_BYTE = 0x0d;
const COMPUTE_COST_PER_COMMAND = 0.5;

export async function ptyRoutes(server: FastifyInstance) {
  server.get<{ Params: { sessionId: string } }>(
    "/pty/:sessionId",
    { websocket: true },
    async (socket, request) => {
      const { sessionId } = request.params;

      // Verify the per-session JWT carried as a WS subprotocol before any
      // registry / sandbox access. Matches the messages WS route.
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
        // RD1: once the workspace is locked (submitted/defending/ended), drop
        // terminal input frame-level — the handshake gate only catches sessions
        // already ended at connect, not a submit that happens mid-session.
        if (!isWritable(entry)) return;
        appendPtyData(sessionId, "input", msg);

        // Compute mechanic: deduct one command's worth per carriage-return
        // in this input chunk. Soft — does not block when depleted.
        let commands = 0;
        for (let i = 0; i < msg.length; i++) {
          if (msg[i] === CR_BYTE) commands++;
        }
        for (let i = 0; i < commands; i++) {
          deductComputeMinutes(sessionId, COMPUTE_COST_PER_COMMAND, "sandbox_command");
        }

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
