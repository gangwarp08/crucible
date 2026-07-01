/**
 * verify-session-link.ts — RD6 (Slice 6.7) acceptance.
 *
 * Server + Supabase: exercises the single-use session-link lifecycle directly
 * against the live session_links table via the service module. Asserts the spec
 * cases:
 *   - a USED token can't start a second session (consume twice → consumed);
 *   - an EXPIRED token is rejected;
 *   - a REVOKED token is rejected;
 *   - an unknown token is rejected;
 *   - a started session can't be hijacked by re-using the link (single-use).
 *
 * Exit 0 on PASS, non-zero on FAIL. SKIPs (non-failing) without Supabase creds.
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { randomUUID } from "crypto";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const url =
  process.env.SUPABASE_URL ??
  (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : null);
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

async function main(): Promise<void> {
  console.log("verify-session-link — RD6 (Slice 6.7)");
  if (!url || !key) {
    console.log("  ⚠ SKIP — Supabase creds absent");
    process.exit(0);
  }

  const {
    createSessionLink,
    consumeSessionLink,
    peekSessionLink,
    revokeSessionLink,
    SessionLinkError,
  } = await import("../src/services/session-link.js");
  const { createClient } = await import("@supabase/supabase-js");
  const { WebSocket } = await import("undici");
  const admin = createClient(url!, key!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    realtime: { transport: WebSocket as any },
  });

  const created: string[] = [];
  async function cleanup(): Promise<void> {
    if (created.length) await admin.from("session_links").delete().in("id", created);
  }

  async function expectError(fn: () => Promise<unknown>, code: string, label: string): Promise<void> {
    try {
      await fn();
      check(label, false, "expected rejection, got success");
    } catch (err) {
      const c = err instanceof SessionLinkError ? err.code : "?";
      check(label, c === code, `expected ${code}, got ${c}`);
    }
  }

  try {
    // ── single-use: consume once, second consume rejected ──
    {
      const { token, link } = await createSessionLink({ candidateLabel: "Alice Test" });
      created.push(link.id);
      check("new link is active", link.status === "active");
      const s1 = randomUUID();
      const consumed = await consumeSessionLink(token, s1);
      check("first consume → consumed + bound to session", consumed.status === "consumed" && consumed.session_id === s1);

      // second start with the SAME link (hijack attempt) → rejected as consumed
      await expectError(() => consumeSessionLink(token, randomUUID()), "consumed", "second consume rejected (consumed)");
      // peek also reports it unusable
      await expectError(() => peekSessionLink(token), "consumed", "peek of used link rejected (consumed)");
    }

    // ── expired: rejected ──
    {
      const { token, link } = await createSessionLink({ candidateLabel: "Bob Expired" });
      created.push(link.id);
      // force expiry in the past
      await admin.from("session_links").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", link.id);
      await expectError(() => peekSessionLink(token), "expired", "expired link peek rejected");
      await expectError(() => consumeSessionLink(token, randomUUID()), "expired", "expired link consume rejected");
    }

    // ── revoked: rejected ──
    {
      const { token, link } = await createSessionLink({ candidateLabel: "Carol Revoked" });
      created.push(link.id);
      const r = await revokeSessionLink(link.id);
      check("revoke → revoked", r.status === "revoked");
      await expectError(() => consumeSessionLink(token, randomUUID()), "revoked", "revoked link consume rejected");
    }

    // ── unknown token: rejected ──
    await expectError(() => consumeSessionLink("not-a-real-token", randomUUID()), "invalid", "unknown token rejected");
    await expectError(() => peekSessionLink("not-a-real-token"), "invalid", "unknown token peek rejected");
  } finally {
    await cleanup();
  }

  console.log(`\n${failed === 0 ? "PASS" : `FAIL (${failed} check(s))`}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
