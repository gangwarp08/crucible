import { z } from "zod";

export const TelemetryEventTypeSchema = z.enum([
  "session.started",
  "session.ended",
  "llm.request",
  "llm.response",
  "sandbox.command",
  "sandbox.file_write",
  "candidate.message",
  "interviewer.message",
]);

export const TelemetryEventSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  type: TelemetryEventTypeSchema,
  /** Epoch ms */
  ts: z.number().int().positive(),
  /** Arbitrary structured payload — typed by each event type downstream */
  payload: z.record(z.string(), z.unknown()),
});
