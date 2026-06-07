// Server-only Supabase service-role client.
// NEVER import this from apps/web — it holds the service-role key.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { WebSocket } from "undici";

function buildClient(): SupabaseClient | null {
  const url =
    process.env.SUPABASE_URL ??
    (process.env.SUPABASE_PROJECT_REF
      ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co`
      : null);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? null;

  if (!url || !key) {
    console.warn(
      "[supabase] SUPABASE_URL/PROJECT_REF or SUPABASE_SERVICE_ROLE_KEY not set — " +
        "Supabase writes are disabled. Session data will not be persisted.",
    );
    return null;
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    // Node 18 has no native WebSocket; undici ships a compatible one.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    realtime: { transport: WebSocket as any },
    global: { headers: { "x-application-name": "crucible-server" } },
  });
}

export const supabase = buildClient();
