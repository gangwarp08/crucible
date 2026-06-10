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

  // JWT secret for server↔browser tokens — optional until auth slice is wired
  JWT_SECRET: z.string().min(32).optional(),

  // Comma-separated list of allowed browser origins (e.g. https://crucible.vercel.app).
  // Required in production; defaults to http://localhost:3000 in dev.
  WEB_ORIGIN: z.string().optional(),
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
