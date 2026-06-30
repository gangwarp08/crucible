// Workspace write-lock guard (Slice 6.2, RD1 — closes the live gaming hole).
//
// Once a candidate submits (status → 'submitted') or the deadline auto-locks
// (→ 'defending'), the workspace is READ-ONLY: no file writes, terminal input,
// AI-assistant calls, deliverable edits, or queries. Otherwise a candidate could
// use the verifier's defense questions as hints to keep editing. Every mutating
// route routes through one of these so the rule can't be forgotten on a new
// endpoint. Only `status === 'active'` is writable.
//
// The verifier (persona) messaging channel is intentionally NOT gated here — the
// defense Q&A happens after submit.

import type { FastifyReply } from "fastify";
import type { SessionEntry } from "./registry.js";

/** True only while the session is writable (active). */
export function isWritable(entry: SessionEntry | null | undefined): boolean {
  return !!entry && entry.status === "active";
}

/**
 * HTTP guard: returns true when writable; otherwise writes the error reply
 * (404 if the session is gone, 409 if read-only) and returns false. Narrows the
 * type so callers can use `entry` after the check.
 */
export function ensureWritable(
  entry: SessionEntry | null | undefined,
  reply: FastifyReply,
): entry is SessionEntry {
  if (!entry) {
    void reply.status(404).send({ error: "Session not found" });
    return false;
  }
  if (entry.status !== "active") {
    void reply.status(409).send({
      error: "session_read_only",
      message: `Your work is locked (session ${entry.status}); no further edits are accepted.`,
    });
    return false;
  }
  return true;
}
