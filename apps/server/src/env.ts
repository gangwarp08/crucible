import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default("0.0.0.0"),

  // Supabase — service-role key is server-only (never NEXT_PUBLIC_)
  SUPABASE_URL: z.string().url().optional(),           // or derive from SUPABASE_PROJECT_REF
  SUPABASE_PROJECT_REF: z.string().min(1).optional(), // used to derive URL when not set directly
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),

  // LiteLLM gateway — provider keys live there, not here
  LITELLM_BASE_URL: z.string().url(),
  LITELLM_MASTER_KEY: z.string().min(1),

  // E2B sandbox
  E2B_API_KEY: z.string().min(1),

  // Redis — optional until rate-limit slice is wired
  REDIS_URL: z.string().url().optional(),

  // Session limits (Hard Rules §5)
  SESSION_BUDGET_USD: z.coerce.number().positive().default(1.0),
  SESSION_TIMEOUT_MIN: z.coerce.number().int().positive().default(60),

  // JWT secret for server↔browser session tokens. REQUIRED — the server
  // refuses to boot without it once per-session JWTs are enforced on the
  // protected routes (services/session-token.ts).
  JWT_SECRET: z.string().min(32),

  // Comma-separated list of allowed browser origins (e.g. https://crucible.vercel.app).
  // Required in production; defaults to http://localhost:3000 in dev.
  WEB_ORIGIN: z.string().optional(),

  // Shared invite code required to start a session. When unset, the gate is
  // off (dev/preview). Set in production to keep stray URL hits from
  // burning LiteLLM + E2B budget.
  INVITE_CODE: z.string().min(1).optional(),

  // Shared secret for the partner outcome webhook (POST /api/outcomes, Slice
  // 5.5). Server-only. When unset, the webhook is DISABLED (returns 503) so an
  // unconfigured deploy can't accept unauthenticated outcome writes; the CSV
  // import script bypasses HTTP and writes via the service role directly.
  OUTCOMES_WEBHOOK_SECRET: z.string().min(16).optional(),

  // L4 interactive verification (Slice 5.4b) feature flag. OFF by default: the
  // near-deadline verification beat is only scheduled when this is "true" (or a
  // per-session test override is passed). Keeps it from firing for real
  // candidates until the verifier UI exists — an unanswered verification would
  // otherwise read as a weak defense and unfairly cap execution.
  VERIFICATION_ENABLED: z.string().optional(),

  // Pilot stance (Slice 6.3): when "true", a verification-driven execution cap
  // is recorded as advisory_pending and does NOT alter the official score until
  // a human confirms it in review. Off → caps apply directly (post-pilot).
  PILOT_VERIFICATION_ADVISORY: z.string().optional(),
});

function loadEnv() {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid environment variables:", result.error.flatten().fieldErrors);
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
