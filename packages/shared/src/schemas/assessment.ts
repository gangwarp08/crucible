import { z } from "zod";

export const AssessmentTaskSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().min(1),
  /** Files to seed inside the E2B sandbox */
  starterFiles: z.record(z.string(), z.string()),
  /** Approximate minutes to complete */
  estimatedMinutes: z.number().int().positive(),
});

export const AssessmentSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  tasks: z.array(AssessmentTaskSchema).min(1),
  /** Hard time limit in minutes, maps to SESSION_TIMEOUT_MIN */
  timeLimitMinutes: z.number().int().positive(),
  /** Hard spend cap in USD, maps to SESSION_BUDGET_USD */
  budgetUsd: z.number().positive(),
  createdAt: z.string().datetime(),
});
