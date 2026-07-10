// family2-harness.ts — shared harness for the family-2 (fde-api-integration)
// calibration verifiers (P3.4). Mirrors the verify-discrimination /
// verify-isomorph-equivalence / verify-fork-discrimination plumbing: scripted
// playthroughs driven through the REAL server (sandbox + personas + judge),
// then evaluations read back from Supabase.
//
// Dormancy note: these scripts are the ONLY sanctioned way to exercise the
// dormant family — internal hand-authored playthroughs via the direct
// scenario id (the catalog never lists it), never real candidates.
//
// Skip semantics (P3 dormant-build rule): every entry point calls guard()
// first and exits 0 with a clear message when env/infra/seed is unavailable
// or --dry-run is passed — the playthrough content stays reviewable via
// describePlaythrough() without touching infra.

import { config as loadEnv } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync, existsSync } from "fs";
import { WebSocket } from "undici";
import WS from "ws";
import {
  type Family2GroundTruth,
  assertGroundTruth,
  allCurveballIds,
  findForkCurveballId,
  DELIVERABLE_KEYS,
  SQL_STATUS_DISTRIBUTION,
  SQL_RECORD_GAP,
  SQL_MISSING_RECORDS,
  SQL_CURSOR_FINGERPRINT,
  SQL_RETRY_FINGERPRINT,
  SQL_WEAK_NAIVE_COUNT,
  MSG_STRONG_CLARIFY_CLIENT,
  MSG_STRONG_TEAM_PUSHBACK,
  MSG_STRONG_FORK_DECLINE,
  MSG_WEAK_CLIENT_VAGUE,
  MSG_WEAK_TEAM_ACK,
  MSG_WEAK_FORK_ACCEPT,
  AI_STRONG_PROMPT,
  strongDeliverable,
  weakDeliverable,
} from "./family2-content.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");
loadEnv({ path: resolve(REPO_ROOT, ".env") });

export const SERVER_URL = process.env.SERVER_URL ?? "http://127.0.0.1:3001";
const FAR = 3_600_000; // push non-fork beats past session end
const FORK_MS = 4_000; // fire the native product-sense fork fast

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── Supabase (service-role; scripts only — never the browser) ──────────────

export function buildSupabase(): SupabaseClient | null {
  const url =
    process.env.SUPABASE_URL ??
    (process.env.SUPABASE_PROJECT_REF
      ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co`
      : null);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    realtime: { transport: WebSocket as any },
  });
}

// ─── Guard: SKIP (exit 0) when the run can't happen ─────────────────────────

export interface ScenarioRow {
  id: string;
  slug: string;
  difficulty: string | null;
  family_id: string | null;
  isomorph_of: string | null;
  dataset_ref: string | null;
  docs: Array<{ id?: string }>;
  curveballs: unknown[];
  deliverable_spec: { components?: Array<{ key?: string }> };
}

export interface GuardResult {
  supabase: SupabaseClient;
  scenarios: Map<string, ScenarioRow>;
  groundTruths: Map<string, Family2GroundTruth & Record<string, unknown>>;
}

export function isDryRun(): boolean {
  return process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";
}

export function skip(msg: string): never {
  console.log(`⚠ SKIP — ${msg}`);
  process.exit(0);
}

/** Env + infra + seed guard. Exits 0 (SKIP) when the LLM/sandbox run cannot
 *  happen; exits 1 only on a content-contract violation (seed present but
 *  drifted from scripts/family2-content.ts — that must be reconciled, not
 *  silently skipped). */
export async function guard(slugs: string[]): Promise<GuardResult> {
  const supabase = buildSupabase();
  if (!supabase) {
    skip("SUPABASE_URL/PROJECT_REF or SUPABASE_SERVICE_ROLE_KEY not set");
  }

  // Server reachable? (needs the live Fastify server + E2B + LiteLLM)
  try {
    const r = await fetch(`${SERVER_URL}/health`);
    if (!r.ok) skip(`server at ${SERVER_URL} unhealthy (HTTP ${r.status})`);
  } catch {
    skip(`server at ${SERVER_URL} unreachable — start it (pnpm --filter @crucible/server dev)`);
  }

  // Family-2 seed applied? (migration 0023)
  const { data, error } = await supabase
    .from("scenarios")
    .select("id, slug, difficulty, family_id, isomorph_of, dataset_ref, docs, curveballs, deliverable_spec")
    .in("slug", slugs);
  if (error) skip(`scenarios read failed: ${error.message}`);
  const rows = (data ?? []) as unknown as ScenarioRow[];
  const missing = slugs.filter((s) => !rows.some((r) => r.slug === s));
  if (missing.length > 0) {
    skip(`family-2 scenario(s) not seeded: ${missing.join(", ")} — apply migration 0023 first`);
  }

  const scenarios = new Map(rows.map((r) => [r.slug, r]));
  const groundTruths = new Map<string, Family2GroundTruth & Record<string, unknown>>();
  for (const row of rows) {
    const ref = row.dataset_ref;
    if (!ref) skip(`${row.slug}: dataset_ref is null — fixture not wired up yet`);
    const gtPath = resolve(REPO_ROOT, ref, "ground_truth.json");
    if (!existsSync(gtPath)) skip(`${row.slug}: ${gtPath} missing — fixtures not authored yet`);
    const gt = JSON.parse(readFileSync(gtPath, "utf8")) as Record<string, unknown>;
    // Seed exists but violates the contract → HARD FAIL (exit 1), because a
    // silent skip here would let a drifted family ship past calibration.
    assertGroundTruth(gt, row.slug);
    groundTruths.set(row.slug, gt);
  }

  return { supabase, scenarios, groundTruths };
}

// ─── Session + WS plumbing (per-session JWT, bearer subprotocol) ────────────

const tokens = new Map<string, string>();
function authHeaders(sessionId: string): Record<string, string> {
  const t = tokens.get(sessionId);
  return t ? { Authorization: `Bearer ${t}` } : {};
}

interface PersonaMsg { channel?: string; role?: string; text?: string }

function openWs(sessionId: string): Promise<WS> {
  const wsBase = SERVER_URL.replace(/^http/, "ws");
  return new Promise((res, rej) => {
    const t = tokens.get(sessionId);
    const ws = new WS(`${wsBase}/messages/${sessionId}`, t ? [`bearer.${t}`] : undefined);
    ws.once("open", () => res(ws));
    ws.once("error", rej);
  });
}

async function createSession(scenario: ScenarioRow): Promise<string> {
  // Fire the native fork fast; push every other beat past session end (the
  // non-fork beats get their own calibration pass, mirroring how family 1
  // calibrated the shortcut fork in isolation).
  const forkId = findForkCurveballId(scenario.curveballs ?? []);
  const overrides: Record<string, number> = {};
  for (const id of allCurveballIds(scenario.curveballs ?? [])) {
    overrides[id] = id === forkId ? FORK_MS : FAR;
  }
  const r = await fetch(`${SERVER_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Include the invite code when the target server has one set (prod parity);
    // harmless when it doesn't (the route ignores it). Lets calibration run
    // against an invite-gated server. (env.INVITE_CODE loaded via dotenv above.)
    body: JSON.stringify({
      scenarioId: scenario.id,
      beatTimingOverridesMs: overrides,
      ...(process.env.INVITE_CODE ? { inviteCode: process.env.INVITE_CODE } : {}),
    }),
  });
  if (!r.ok) throw new Error(`session create failed: ${r.status} ${await r.text()}`);
  const body = (await r.json()) as { sessionId: string; token?: string };
  if (body.token) tokens.set(body.sessionId, body.token);
  return body.sessionId;
}

/** Map the 4 authored deliverable blocks onto the scenario's actual component
 *  keys — by name when they match the contract, by position (with a warning)
 *  when P3.1 named them differently. */
function mapDeliverable(scenario: ScenarioRow, blocks: string[]): Record<string, string> {
  const specKeys = (scenario.deliverable_spec?.components ?? [])
    .map((c) => (typeof c?.key === "string" ? c.key : ""))
    .filter((k) => k.length > 0);
  const expected = [...DELIVERABLE_KEYS] as string[];
  const keys = specKeys.length === blocks.length ? specKeys : expected;
  if (specKeys.length > 0 && JSON.stringify(specKeys) !== JSON.stringify(expected)) {
    console.warn(
      `  [${scenario.slug}] deliverable keys differ from the content contract — ` +
        `mapping by position (spec: ${specKeys.join(", ") || "(none)"})`,
    );
  }
  const data: Record<string, string> = {};
  keys.forEach((k, i) => { if (blocks[i] !== undefined) data[k] = blocks[i]!; });
  return data;
}

// ─── Playthroughs ────────────────────────────────────────────────────────────

export type PlayMode = "strong" | "weak";

/** Print the complete hand-authored playthrough (dry-run review path). */
export function describePlaythrough(mode: PlayMode, gt: Family2GroundTruth): void {
  const blocks = mode === "strong" ? strongDeliverable(gt) : weakDeliverable(gt);
  console.log(`\n────── ${mode.toUpperCase()} playthrough (fde-api-integration) ──────`);
  if (mode === "strong") {
    console.log(`[client] ${MSG_STRONG_CLARIFY_CLIENT}`);
    console.log(`[docs]   view ALL scenario docs`);
    for (const [i, sql] of [SQL_STATUS_DISTRIBUTION, SQL_RECORD_GAP, SQL_MISSING_RECORDS, SQL_CURSOR_FINGERPRINT, SQL_RETRY_FINGERPRINT].entries()) {
      console.log(`[sql ${i + 1}]\n${sql}`);
    }
    console.log(`[team]   ${MSG_STRONG_TEAM_PUSHBACK}`);
    console.log(`[fork]   DECLINE the hardcode: ${MSG_STRONG_FORK_DECLINE}`);
    console.log(`[ai]     ${AI_STRONG_PROMPT}`);
  } else {
    console.log(`[client] ${MSG_WEAK_CLIENT_VAGUE}`);
    console.log(`[docs]   (none — anti-pattern)`);
    console.log(`[sql 1]\n${SQL_WEAK_NAIVE_COUNT}`);
    console.log(`[team]   ${MSG_WEAK_TEAM_ACK}`);
    console.log(`[fork]   ACCEPT the hardcode: ${MSG_WEAK_FORK_ACCEPT}`);
    console.log(`[ai]     (zero turns — anti-pattern)`);
  }
  DELIVERABLE_KEYS.forEach((k, i) => console.log(`[deliverable.${k}]\n${blocks[i]}`));
}

/** Run one scripted playthrough end to end; returns the sessionId (evaluation
 *  is auto-triggered by the DELETE). */
export async function runPlaythrough(
  mode: PlayMode,
  scenario: ScenarioRow,
  gt: Family2GroundTruth,
): Promise<string> {
  const sessionId = await createSession(scenario);
  const tag = `${mode}/${scenario.slug}`;
  console.log(`  [${tag}] session ${sessionId}`);
  const post = (path: string, body: unknown) =>
    fetch(`${SERVER_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(sessionId) },
      body: JSON.stringify(body),
    });

  const inbox: PersonaMsg[] = [];
  let ws: WS | undefined;
  try {
    ws = await openWs(sessionId);
    ws.on("message", (raw: WS.RawData) => {
      try {
        const m = JSON.parse(raw.toString()) as PersonaMsg;
        if (m.channel) inbox.push(m);
      } catch { /* non-JSON frame */ }
    });
  } catch (err) {
    console.warn(`  [${tag}] WS unavailable (${(err as Error).message}) — continuing without messaging`);
  }

  // [1] Client channel: clarify (strong) vs vague ping (weak).
  if (ws) {
    ws.send(JSON.stringify({
      channel: "client",
      text: mode === "strong" ? MSG_STRONG_CLARIFY_CLIENT : MSG_WEAK_CLIENT_VAGUE,
    }));
    await sleep(8_000);
  }

  // [2] Docs: strong views everything; weak skips them (anti-pattern).
  if (mode === "strong") {
    for (const doc of scenario.docs ?? []) {
      if (typeof doc?.id !== "string") continue;
      await post(`/api/sessions/${sessionId}/docs/${doc.id}/view`, {}).catch(() => {});
    }
    console.log(`  [${tag}] viewed ${scenario.docs?.length ?? 0} docs`);
  } else {
    console.log(`  [${tag}] intentionally skipped all docs`);
  }

  // [3] Investigation queries.
  const sqls = mode === "strong"
    ? [SQL_STATUS_DISTRIBUTION, SQL_RECORD_GAP, SQL_MISSING_RECORDS, SQL_CURSOR_FINGERPRINT, SQL_RETRY_FINGERPRINT]
    : [SQL_WEAK_NAIVE_COUNT];
  for (const sql of sqls) {
    const res = await post(`/api/sessions/${sessionId}/query`, { sql })
      .then((r) => r.json() as Promise<{ status?: string; error?: string }>)
      .catch(() => ({ status: "error", error: "fetch failed" }));
    if (res.status !== "ok") {
      console.warn(`  [${tag}] query returned ${res.status}: ${String(res.error ?? "").slice(0, 90)}`);
    }
  }
  console.log(`  [${tag}] ran ${sqls.length} quer${sqls.length === 1 ? "y" : "ies"}`);

  // [4] Wait for the native fork beat (teammate pitches the hardcoded
  //     workaround), then diverge by mode. The decision also lands in the
  //     deliverable — the fork's PRIMARY (Stage-A) evidence.
  const forkRe = /hardcode|workaround|quick fix|pin|skip|ship|patch|fastest|deadline/i;
  let sawFork = false;
  for (let i = 0; i < 30 && ws; i++) {
    if (inbox.some((m) => m.channel === "team" && forkRe.test(m.text ?? ""))) { sawFork = true; break; }
    await sleep(1_000);
  }
  if (ws) {
    if (mode === "strong") {
      ws.send(JSON.stringify({ channel: "team", text: MSG_STRONG_FORK_DECLINE }));
      await sleep(6_000);
      ws.send(JSON.stringify({ channel: "team", text: MSG_STRONG_TEAM_PUSHBACK }));
    } else {
      ws.send(JSON.stringify({ channel: "team", text: MSG_WEAK_FORK_ACCEPT + " " + MSG_WEAK_TEAM_ACK }));
    }
    await sleep(6_000);
  }
  console.log(`  [${tag}] fork ${mode === "strong" ? "DECLINED" : "ACCEPTED"} (beat seen: ${sawFork})`);

  // [5] AI assistant: strong makes one focused, verified turn; weak none.
  if (mode === "strong") {
    const cr = await post("/api/chat", { sessionId, prompt: AI_STRONG_PROMPT }).catch(() => null);
    console.log(`  [${tag}] AI-assistant turn ${cr && cr.ok ? "ok" : "SKIP (unavailable/quota)"}`);
  }

  if (ws) { try { ws.close(); } catch { /* already closed */ } }

  // [6] Deliverable (the fork decision is stated inside it) + end → auto-eval.
  const blocks = mode === "strong" ? strongDeliverable(gt) : weakDeliverable(gt);
  const dr = await post(`/api/sessions/${sessionId}/deliverable`, {
    status: "submitted",
    data: mapDeliverable(scenario, blocks),
  });
  if (!dr.ok) console.error(`  [${tag}] deliverable submit FAILED: ${dr.status} ${(await dr.text()).slice(0, 120)}`);
  await fetch(`${SERVER_URL}/sessions/${sessionId}`, { method: "DELETE", headers: { ...authHeaders(sessionId) } });
  console.log(`  [${tag}] DELETEd → auto-eval`);
  return sessionId;
}

// ─── Evaluation readback ─────────────────────────────────────────────────────

export interface EvalItem { competency: string; score: number | null; weight: number }
export interface EvalRow { overall_score: number; status: string; items: EvalItem[]; summary: string | null }

export async function pollEval(
  supabase: SupabaseClient,
  sessionId: string,
  timeoutMs: number,
): Promise<EvalRow | null> {
  const deadline = Date.now() + timeoutMs;
  let reeval = 0;
  while (Date.now() < deadline) {
    await sleep(2_000);
    const { data: row } = await supabase
      .from("evaluations")
      .select("id, overall_score, status, summary")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!row) continue;
    const r = row as { id: string; overall_score: number | string; status: string; summary: string | null };
    // Transient LiteLLM failures land status='error' — re-trigger analysis up
    // to twice (same recovery as verify-fork-discrimination).
    if (r.status === "error" && reeval < 2) {
      reeval++;
      console.log(`  [${sessionId.slice(0, 8)}] eval status=error (transient) — re-evaluating (${reeval})`);
      await fetch(`${SERVER_URL}/api/review/sessions/${sessionId}/evaluate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      }).catch(() => {});
      await sleep(4_000);
      continue;
    }
    if (r.status !== "complete") continue;
    const { data: items } = await supabase
      .from("evaluation_items")
      .select("competency, score, weight")
      .eq("evaluation_id", r.id);
    return {
      overall_score: Number(r.overall_score),
      status: r.status,
      summary: r.summary,
      items: (items ?? []) as EvalItem[],
    };
  }
  return null;
}
