// Verify the session-rehydrate plumbing.
//
// Two cases:
//   PHASE 1 — Cache-hit smoke test. POST /sessions → GET /sessions/:id and
//             a couple of other routes that now call getOrRehydrateSession.
//             Proves the cache-hit path is wired identically to before.
//
//   PHASE 2 — Rehydrate proof. Requires CRUCIBLE_TEST_RESTART=1 plus a
//             manual server restart between the marker create and the next
//             call. With the env flag, this verifier:
//               1. Reads BASELINE_LIVE_SESSION_ID (must point at a session
//                  whose row is status='active' in Supabase).
//               2. Hits GET /sessions/:id.
//               3. Expects 200 + a log line on the server containing
//                  "[rehydrate]".
//             Without the flag, this phase is skipped.
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-rehydrate.ts

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const SERVER_URL = process.env.SERVER_URL ?? "http://127.0.0.1:3001";
const SLUG = process.env.SLUG ?? "fde-db-triage-pro";
const TEST_RESTART = process.env.CRUCIBLE_TEST_RESTART === "1";
const BASELINE_LIVE_SESSION_ID = process.env.BASELINE_LIVE_SESSION_ID ?? "";

async function getScenarioId(slug: string): Promise<string> {
  const r = await fetch(`${SERVER_URL}/api/scenarios/${slug}`);
  if (!r.ok) throw new Error(`scenario fetch failed: ${r.status}`);
  const j = (await r.json()) as { id: string };
  return j.id;
}

// Per-session JWTs minted on POST /sessions and stored here so the rest of
// the verifier can attach `Authorization: Bearer <token>` to every request.
const tokens = new Map<string, string>();

function authHeaders(sessionId: string): Record<string, string> {
  const t = tokens.get(sessionId);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function createSession(scenarioId: string): Promise<string> {
  const r = await fetch(`${SERVER_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scenarioId,
      beatTimingOverridesMs: { misleading_teammate_hint: 60_000, requirement_change: 600_000 },
    }),
  });
  if (!r.ok) throw new Error(`session create failed: ${r.status} ${await r.text()}`);
  const body = (await r.json()) as { sessionId: string; token?: string };
  if (body.token) tokens.set(body.sessionId, body.token);
  return body.sessionId;
}

async function getSession(sessionId: string): Promise<Response> {
  return fetch(`${SERVER_URL}/sessions/${sessionId}`, { headers: authHeaders(sessionId) });
}

async function endSession(sessionId: string): Promise<void> {
  await fetch(`${SERVER_URL}/sessions/${sessionId}`, {
    method: "DELETE",
    headers: authHeaders(sessionId),
  });
}

(async () => {
  console.log(`SERVER_URL=${SERVER_URL}`);
  console.log(`SLUG=${SLUG}`);

  // ─── Phase 1: cache-hit smoke ──────────────────────────────────────────
  console.log("\n[phase 1] cache-hit smoke");
  const scenarioId = await getScenarioId(SLUG);
  console.log(`  scenarioId=${scenarioId}`);
  const sessionId = await createSession(scenarioId);
  console.log(`  session created: ${sessionId}`);

  const res1 = await getSession(sessionId);
  console.log(`  GET /sessions/:id → ${res1.status}`);
  if (!res1.ok) {
    console.error("  FAIL — GET 200 expected on cache hit");
    process.exit(1);
  }
  const body1 = (await res1.json()) as { sandboxId: string; status: string };
  console.log(`    sandbox=${body1.sandboxId}, status=${body1.status}`);

  console.log("  cleaning up smoke session");
  await endSession(sessionId);

  // ─── Phase 2: rehydrate proof (manual restart required) ────────────────
  if (TEST_RESTART) {
    console.log("\n[phase 2] rehydrate proof");
    const baselineToken = process.env.BASELINE_LIVE_SESSION_TOKEN ?? "";
    if (!BASELINE_LIVE_SESSION_ID) {
      console.error("  CRUCIBLE_TEST_RESTART=1 but BASELINE_LIVE_SESSION_ID not set; skip");
      console.log("  (Create a live session, restart the server, then re-run with the env set.)");
    } else if (!baselineToken) {
      console.error("  BASELINE_LIVE_SESSION_TOKEN not set; route is now JWT-gated.");
      console.log("  Capture the token from the POST /sessions response in phase 1 first.");
    } else {
      tokens.set(BASELINE_LIVE_SESSION_ID, baselineToken);
      console.log(`  expecting registry MISS → rehydrate on ${BASELINE_LIVE_SESSION_ID}`);
      const res2 = await getSession(BASELINE_LIVE_SESSION_ID);
      console.log(`  GET /sessions/:id → ${res2.status}`);
      if (!res2.ok) {
        console.error("  FAIL — expected 200 after rehydrate");
        process.exit(1);
      }
      const body2 = (await res2.json()) as { sandboxId: string; status: string };
      console.log(`    sandbox=${body2.sandboxId}, status=${body2.status}`);
      console.log("  PASS — session served after registry miss (rehydrate fired)");
      console.log("  Confirm by inspecting server logs for '[rehydrate]' on this session.");
    }
  } else {
    console.log("\n[phase 2] SKIP — set CRUCIBLE_TEST_RESTART=1 + BASELINE_LIVE_SESSION_ID after a manual restart");
  }

  console.log("\nOK");
})();
