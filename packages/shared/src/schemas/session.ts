import { z } from "zod";

export const SessionStatusSchema = z.enum([
  "pending",
  "active",
  "completed",
  "timed_out",
  "error",
]);

export const SessionSchema = z.object({
  id: z.string().uuid(),
  assessmentId: z.string().uuid(),
  candidateId: z.string().uuid(),
  status: SessionStatusSchema,
  /** Remaining budget in USD */
  budgetUsd: z.number().nonnegative(),
  /** Wall-clock deadline (ISO 8601) */
  expiresAt: z.string().datetime(),
  /** E2B sandbox identifier — server-side only, not sent to the browser */
  sandboxId: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const CreateSessionRequestSchema = z.object({
  assessmentId: z.string().uuid(),
  candidateId: z.string().uuid(),
});

/** Subset safe to return to the browser (no sandboxId) */
export const PublicSessionSchema = SessionSchema.omit({ sandboxId: true });
