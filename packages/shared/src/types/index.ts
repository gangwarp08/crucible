import type { z } from "zod";
import type {
  SessionSchema,
  CreateSessionRequestSchema,
  SessionStatusSchema,
} from "../schemas/session.js";
import type { AssessmentTaskSchema, AssessmentSchema } from "../schemas/assessment.js";
import type { TelemetryEventSchema } from "../schemas/telemetry.js";

export type Session = z.infer<typeof SessionSchema>;
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export type AssessmentTask = z.infer<typeof AssessmentTaskSchema>;
export type Assessment = z.infer<typeof AssessmentSchema>;

export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
