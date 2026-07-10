/**
 * verify-live-monitoring.ts — Live session monitoring (SSE) acceptance.
 *
 * Covers GET /api/review/sessions/:id/live (route in routes/review.ts, backed
 * by services/live-stream.ts):
 *   [access] org matrix — admin stream opens; foreign partner org → 404 with
 *            NO data frames; no key (ORG_AUTH_REQUIRED=true) → 401; bad uuid
 *            → 400. All BEFORE any byte is streamed (uniform-404, no leak).
 *   [events] the events frame carries only rows with seq > ?since, ascending,
 *            and catches up from the supplied resume point.
 *   [end]    a terminal session emits an `end` frame and closes the stream.
 *   [status] the initial status frame carries {status,spend_usd,budget_usd,
 *            deadline,ended_at}.
 *   [no-write] static scan: the route file opens no Supabase write call.
 *
 * The access-matrix + bad-input cases use fastify.inject (the org gate returns
 * a normal JSON response before the reply is hijacked). The live streaming
 * cases open a REAL TCP connection to a listening instance and parse SSE
 * frames, because inject can't observe a hijacked raw socket.
 *
 * ORG_AUTH_REQUIRED is forced to "true" for this process so the no-key → 401
 * path is exercised; every other request carries an explicit X-Org-Key.
 *
 * Infra: Supabase service-role only (no sandbox, no LLM, no full server —
 * registers just reviewRoutes on a bare Fastify instance). Cleans up everything
 * it seeds. Exit 0 PASS / 1 FAIL; SKIPs (exit 0) without Supabase creds or
 * before migration 0018.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-live-monitoring.ts
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import http from "node:http";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

// Force key-required mode BEFORE env.js is imported (transitively, via the
// route module) so the no-key → 401 case is real, not back-compat fallback.
process.env.ORG_AUTH_REQUIRED = "true";
// Minimal env the route's transitive imports need if the .env is sparse.
process.env.JWT_SECRET ??= "x".repeat(48);
process.env.LITELLM_BASE_URL ??= "http://localhost:4000";
process.env.LITELLM_MASTER_KEY ??= "sk-master-verify";
process.env.E2B_API_KEY ??= "verify-e2b";

const url =
  process.env.SUPABASE_URL ??
  (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : null);
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

/** Parse a raw SSE body into ordered {event,data} frames. */
function parseSse(body: string): Array<{ event: string; data: unknown }> {
  const frames: Array<{ event: string; data: unknown }> = [];
  for (const block of body.split("\n\n")) {
    const lines = block.split("\n");
    let event = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    let data: unknown = dataLines.join("\n");
    try {
      data = JSON.parse(dataLines.join("\n"));
    } catch {
      /* non-JSON frame (e.g. the priming comment) — keep raw */
    }
    frames.push({ event, data });
  }
  return frames;
}

/** Open a real SSE connection, collect frames until the server closes the
 *  socket or `maxMs` elapses, then resolve with status + parsed frames. */
function streamSse(
  port: number,
  path: string,
  headers: Record<string, string>,
  maxMs: number,
): Promise<{ status: number; frames: Array<{ event: string; data: unknown }>; raw: string }> {
  return new Promise((resolvePromise, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
      let raw = "";
      const timer = setTimeout(() => {
        res.destroy();
        req.destroy();
        resolvePromise({ status: res.statusCode ?? 0, frames: parseSse(raw), raw });
      }, maxMs);
      res.on("data", (chunk) => {
        raw += chunk.toString();
      });
      res.on("end", () => {
        clearTimeout(timer);
        resolvePromise({ status: res.statusCode ?? 0, frames: parseSse(raw), raw });
      });
      res.on("error", () => {
        clearTimeout(timer);
        resolvePromise({ status: res.statusCode ?? 0, frames: parseSse(raw), raw });
      });
    });
    req.on("error", reject);
  });
}

async function main(): Promise<void> {
  console.log("verify-live-monitoring — live SSE session monitoring");

  // ── [no-write] static scan (runs with or without Supabase) ──────────────
  // The live route (in review.ts) does ALL its Supabase access through the
  // live-stream.ts service module, so that module is the surface to scan: it
  // must be read-only. We also scan the live route BLOCK in review.ts (from the
  // "Live session monitoring" marker to end of file) to confirm the handler
  // itself opens no direct write path.
  console.log("\n[no-write] static no-write scan of the live-stream module + route block");
  const stripComments = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
  const writeVerbs = /\.(insert|update|upsert|delete|rpc)\s*\(/g;

  const liveModule = stripComments(readFileSync(resolve(here, "../src/services/live-stream.ts"), "utf8"));
  const moduleHits = liveModule.match(writeVerbs) ?? [];
  check("live-stream.ts makes no supabase write call (insert/update/upsert/delete/rpc)", moduleHits.length === 0, moduleHits.join(", "));
  check("live-stream.ts selects only (has .select)", /\.select\s*\(/.test(liveModule));

  const reviewSrc = readFileSync(resolve(here, "../src/routes/review.ts"), "utf8");
  const marker = reviewSrc.indexOf("Live session monitoring (SSE");
  check("review.ts contains the live-monitoring route block", marker !== -1);
  if (marker !== -1) {
    const liveBlock = stripComments(reviewSrc.slice(marker));
    const blockHits = liveBlock.match(writeVerbs) ?? [];
    check("live route block opens no supabase write call", blockHits.length === 0, blockHits.join(", "));
    check("live route block hijacks the reply for raw SSE", /reply\.hijack\s*\(\s*\)/.test(liveBlock));
    check("live route block sets text/event-stream", /text\/event-stream/.test(liveBlock));
  }

  if (!url || !key) {
    console.log("\n  ⚠ SKIP (live cases) — Supabase creds absent");
    process.exit(failed === 0 ? 0 : 1);
  }

  const { supabase } = await import("../src/services/supabase.js");
  if (!supabase) {
    console.log("\n  ⚠ SKIP (live cases) — service-role client unavailable");
    process.exit(failed === 0 ? 0 : 1);
  }
  const orgsProbe = await supabase.from("orgs").select("id").limit(1);
  if (orgsProbe.error) {
    console.log(`\n  ⚠ SKIP (live cases) — orgs table unavailable (0018 not applied?): ${orgsProbe.error.message}`);
    process.exit(failed === 0 ? 0 : 1);
  }

  const { createOrg, clearOrgCache } = await import("../src/services/orgs.js");
  const { reviewRoutes } = await import("../src/routes/review.js");
  const Fastify = (await import("fastify")).default;

  const suffix = randomUUID().slice(0, 8);
  const seeded = { orgIds: [] as string[], sessionIds: [] as string[] };
  async function cleanup(): Promise<void> {
    if (seeded.sessionIds.length) await supabase!.from("sessions").delete().in("id", seeded.sessionIds);
    if (seeded.orgIds.length) await supabase!.from("orgs").delete().in("id", seeded.orgIds);
    clearOrgCache();
  }

  // Seed helper: one session (given status) owned by an org, with N events.
  async function seedSession(
    orgId: string,
    status: string,
    eventCount: number,
    opts: { deadlineMs?: number; endedAt?: string | null } = {},
  ): Promise<string> {
    const sessionId = randomUUID();
    const deadline = new Date(Date.now() + (opts.deadlineMs ?? 30 * 60_000)).toISOString();
    const { error: sErr } = await supabase!.from("sessions").insert({
      id: sessionId,
      sandbox_id: `verify-live-${suffix}`,
      template: "verify",
      litellm_key_alias: `verify-${sessionId}`,
      model: "none",
      budget_usd: 2.5,
      spend_usd: 0.1,
      timeout_min: 30,
      deadline,
      status,
      ended_at: opts.endedAt ?? null,
      org_id: orgId,
    });
    if (sErr) throw new Error(`session seed failed: ${sErr.message}`);
    seeded.sessionIds.push(sessionId);
    if (eventCount > 0) {
      const rows = Array.from({ length: eventCount }, (_, i) => ({
        id: randomUUID(),
        session_id: sessionId,
        seq: i,
        type: `verify.event.${i}`,
        actor: "system",
        ts: new Date(Date.now() + i).toISOString(),
        payload: { i },
      }));
      const { error: eErr } = await supabase!.from("events").insert(rows);
      if (eErr) throw new Error(`event seed failed: ${eErr.message}`);
    }
    return sessionId;
  }

  const server = Fastify({ logger: false });
  let port = 0;

  try {
    const admin = await createOrg(`Live Admin ${suffix}`, `test-live-admin-${suffix}`);
    const partnerA = await createOrg(`Live A ${suffix}`, `test-live-a-${suffix}`);
    const partnerB = await createOrg(`Live B ${suffix}`, `test-live-b-${suffix}`);
    seeded.orgIds.push(admin.org.id, partnerA.org.id, partnerB.org.id);
    // Promote the "admin" org to role admin so it sees all sessions.
    await supabase.from("orgs").update({ role: "admin" }).eq("id", admin.org.id);
    clearOrgCache();

    // Active session owned by partner A.
    const activeId = await seedSession(partnerA.org.id, "active", 5);
    // Terminal session owned by partner A (completed, with backlog).
    const doneId = await seedSession(partnerA.org.id, "completed", 3, { endedAt: new Date().toISOString() });

    await server.register(reviewRoutes, { prefix: "/api/review" });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const addr = server.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const keyHeader = (k: string) => ({ "X-Org-Key": k });

    // ── [access] org matrix + bad input (inject: pre-hijack JSON responses) ──
    console.log("\n[access] org access matrix (pre-stream, uniform-404)");

    const bad = await server.inject({
      method: "GET",
      url: "/api/review/sessions/not-a-uuid/live",
      headers: keyHeader(partnerA.apiKey),
    });
    check("bad uuid → 400", bad.statusCode === 400, `got ${bad.statusCode}`);

    const noKey = await server.inject({
      method: "GET",
      url: `/api/review/sessions/${activeId}/live`,
    });
    check("no X-Org-Key (ORG_AUTH_REQUIRED) → 401", noKey.statusCode === 401, `got ${noKey.statusCode}`);
    check("401 body carries NO event frames", !/event:\s/.test(noKey.body), noKey.body.slice(0, 80));

    const foreign = await server.inject({
      method: "GET",
      url: `/api/review/sessions/${activeId}/live`,
      headers: keyHeader(partnerB.apiKey),
    });
    check("foreign partner org → 404 (no existence leak)", foreign.statusCode === 404, `got ${foreign.statusCode}`);
    check("foreign 404 body carries NO event frames / no data", !/event:\s|data:\s/.test(foreign.body), foreign.body.slice(0, 80));

    const missing = await server.inject({
      method: "GET",
      url: `/api/review/sessions/${randomUUID()}/live`,
      headers: keyHeader(partnerA.apiKey),
    });
    check("unknown session id → 404 (same as foreign)", missing.statusCode === 404, `got ${missing.statusCode}`);

    // ── [status]+[events] admin stream opens; catch-up from ?since ──────────
    console.log("\n[status]+[events] admin stream opens; ?since resume");

    // Admin follows the ACTIVE session; give the poll loop a couple of ticks.
    // No ?since → catch up from the very beginning (seq 0 included).
    const adminStream = await streamSse(
      port,
      `/api/review/sessions/${activeId}/live`,
      keyHeader(admin.apiKey),
      2500,
    );
    const statusFrame = adminStream.frames.find((f) => f.event === "status");
    check("admin stream opens and emits a status frame", !!statusFrame, `frames=${adminStream.frames.map((f) => f.event).join(",")}`);
    if (statusFrame) {
      const d = statusFrame.data as Record<string, unknown>;
      check(
        "status frame shape {status,spend_usd,budget_usd,deadline,ended_at}",
        d.status === "active" &&
          typeof d.spend_usd === "number" &&
          typeof d.budget_usd === "number" &&
          typeof d.deadline === "string" &&
          "ended_at" in d,
        JSON.stringify(d),
      );
      check("budget_usd/spend_usd coerced to numbers", d.budget_usd === 2.5 && d.spend_usd === 0.1, JSON.stringify(d));
    }
    const evFrames = adminStream.frames.filter((f) => f.event === "events");
    const allEvents = evFrames.flatMap((f) => (f.data as { events: Array<{ seq: number }> }).events);
    check("events frame delivered for the active session", allEvents.length === 5, `got ${allEvents.length}`);
    const seqs = allEvents.map((e) => e.seq);
    check("events are ascending by seq", seqs.every((s, i) => i === 0 || s > seqs[i - 1]!), seqs.join(","));
    check(
      "event row shape {seq,type,actor,payload,created_at}",
      allEvents.length > 0 &&
        (() => {
          const e = allEvents[0] as Record<string, unknown>;
          return typeof e.seq === "number" && typeof e.type === "string" && typeof e.actor === "string" && "payload" in e && "created_at" in e;
        })(),
    );

    // Resume from seq=2 → only seq 3,4 (0-indexed; 5 events are seq 0..4).
    const resumeStream = await streamSse(
      port,
      `/api/review/sessions/${activeId}/live?since=2`,
      keyHeader(admin.apiKey),
      2000,
    );
    const resumeEvents = resumeStream.frames
      .filter((f) => f.event === "events")
      .flatMap((f) => (f.data as { events: Array<{ seq: number }> }).events);
    check(
      "?since=2 delivers ONLY seq>2 (seq 3,4)",
      resumeEvents.length === 2 && resumeEvents.every((e) => e.seq > 2),
      resumeEvents.map((e) => e.seq).join(","),
    );

    // Explicit ?since=0 is STRICT (> 0): it skips seq 0 (delivers seq 1..4).
    // This locks the "absent = from beginning, explicit N = strictly after N"
    // contract so seq 0 is never silently dropped for a fresh watcher.
    const strictZero = await streamSse(
      port,
      `/api/review/sessions/${activeId}/live?since=0`,
      keyHeader(admin.apiKey),
      2000,
    );
    const strictEvents = strictZero.frames
      .filter((f) => f.event === "events")
      .flatMap((f) => (f.data as { events: Array<{ seq: number }> }).events);
    check(
      "?since=0 is strict (> 0): delivers seq 1..4, skips seq 0",
      strictEvents.length === 4 && strictEvents.every((e) => e.seq > 0),
      strictEvents.map((e) => e.seq).join(","),
    );

    // ── [end] terminal session emits `end` and closes ───────────────────────
    console.log("\n[end] terminal session emits end + closes");
    const endStream = await streamSse(
      port,
      `/api/review/sessions/${doneId}/live`,
      keyHeader(admin.apiKey),
      3000,
    );
    const endFrame = endStream.frames.find((f) => f.event === "end");
    check("terminal session emits an `end` frame", !!endFrame, `frames=${endStream.frames.map((f) => f.event).join(",")}`);
    if (endFrame) {
      const reason = (endFrame.data as { reason?: string }).reason;
      check("end frame reason reflects terminal status", reason === "completed", String(reason));
    }
    // The server closed the socket, so res 'end' fired well before maxMs — the
    // backlog (3 events) still came through first.
    const doneBacklog = endStream.frames
      .filter((f) => f.event === "events")
      .flatMap((f) => (f.data as { events: Array<{ seq: number }> }).events);
    check("terminal session still delivered its event backlog before end", doneBacklog.length === 3, `got ${doneBacklog.length}`);
    check("stream closed after end (frames end with `end`)", endStream.frames[endStream.frames.length - 1]?.event === "end");

    // Foreign org on the streaming path too: 404, no stream.
    const foreignStream = await streamSse(
      port,
      `/api/review/sessions/${activeId}/live`,
      keyHeader(partnerB.apiKey),
      1500,
    );
    check("foreign org on streaming path → 404, no frames", foreignStream.status === 404 && foreignStream.frames.length === 0, `status=${foreignStream.status} frames=${foreignStream.frames.length}`);
  } finally {
    await server.close().catch(() => {});
    await cleanup();
  }

  console.log(failed === 0 ? "\nPASS" : `\nFAIL — ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-live-monitoring crashed:", err);
  process.exit(1);
});
