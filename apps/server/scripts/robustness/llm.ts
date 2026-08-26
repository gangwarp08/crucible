// Gemini simulator driver — the AI that decides what each candidate persona
// does. Runs on a DEDICATED LiteLLM virtual key (separate from the per-session
// candidate keys the server mints), so all simulator spend is attributable and
// capped independently. Every call still goes through the LiteLLM gateway —
// never to Google directly (CLAUDE.md Hard Rule 3).

import { REPO_ROOT } from "./shared.js";
import { config as loadEnv } from "dotenv";
import { resolve } from "path";

loadEnv({ path: resolve(REPO_ROOT, ".env") });

const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL ?? "";
const LITELLM_MASTER_KEY = process.env.LITELLM_MASTER_KEY ?? "";

// Per-tier model selection. The Railway gateway currently exposes only the
// `gemini-flash` alias, so both default to it. Once `gemini-2.5-flash` and
// `gemini-3-flash` are added as models on the gateway, set:
//   SIM_MODEL_BULK=gemini-2.5-flash   (cheaper — median/weak/profile personas)
//   SIM_MODEL_STRONG=gemini-3-flash   (stronger reasoning — strong personas)
// and the harness routes per persona with zero code changes.
export const SIM_MODEL = process.env.SIM_MODEL ?? "gemini-flash";
export const SIM_MODEL_BULK = process.env.SIM_MODEL_BULK ?? SIM_MODEL;
export const SIM_MODEL_STRONG = process.env.SIM_MODEL_STRONG ?? SIM_MODEL;

/** The distinct model aliases the simulator key must be allowed to call. */
export function simModelAllowlist(): string[] {
  return [...new Set([SIM_MODEL, SIM_MODEL_BULK, SIM_MODEL_STRONG])];
}

/** Pick a model for a persona skill: stronger personas get the stronger tier. */
export function modelForSkill(skill: string): string {
  return skill === "strong" || skill === "above_avg" ? SIM_MODEL_STRONG : SIM_MODEL_BULK;
}

export function litellmConfigured(): boolean {
  return Boolean(LITELLM_BASE_URL && LITELLM_MASTER_KEY);
}

export interface SimKeyOpts {
  alias: string;
  maxBudgetUsd: number;
  durationMinutes: number;
}

// Live simulator key state. A full SPEED=1 pass runs longer (~16h) than any
// single key's `duration` TTL, so the key WILL expire mid-run. We keep the mint
// opts and the current key here so simChat can transparently re-mint on expiry
// (see remintOnExpiry) instead of aborting every remaining session with a 401.
let activeSimKey: string | null = null;
let activeSimKeyOpts: SimKeyOpts | null = null;
let remintInFlight: Promise<string> | null = null;

/** The freshest simulator key (post any re-mint), falling back to the caller's. */
function currentSimKey(fallback: string): string {
  return activeSimKey ?? fallback;
}

async function generateSimKey(opts: SimKeyOpts): Promise<string> {
  const res = await fetch(`${LITELLM_BASE_URL}/key/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LITELLM_MASTER_KEY}`,
    },
    body: JSON.stringify({
      key_alias: opts.alias,
      max_budget: opts.maxBudgetUsd,
      models: simModelAllowlist(),
      duration: `${opts.durationMinutes}m`,
      metadata: { purpose: "robustness-simulator" },
    }),
  });
  if (!res.ok) throw new Error(`simulator key/generate failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { key: string };
  return data.key;
}

/** Mint a dedicated simulator key with its own budget + expiry. Mirrors the
 *  server's mintSessionKey (litellm.ts:79) but for the candidate-driver side.
 *  maxBudgetUsd is the HARD cap for the whole run's simulator spend. Records the
 *  opts so the key can be auto-re-minted on expiry mid-run. */
export async function mintSimulatorKey(opts: SimKeyOpts): Promise<string> {
  const key = await generateSimKey(opts);
  activeSimKey = key;
  activeSimKeyOpts = opts;
  return key;
}

/** Re-mint the simulator key after an expiry, de-duplicating concurrent callers
 *  (all in-flight workers hit the 401 at once) so only one new key is minted.
 *  The stale key is left to be reaped by its own expiry — no delete race. */
async function remintOnExpiry(expiredKey: string): Promise<string> {
  if (!activeSimKeyOpts) throw new Error("cannot re-mint simulator key: no mint opts recorded");
  // Another worker already swapped in a fresh key — use it.
  if (activeSimKey && activeSimKey !== expiredKey) return activeSimKey;
  if (!remintInFlight) {
    const opts = activeSimKeyOpts;
    remintInFlight = generateSimKey(opts)
      .then((key) => { activeSimKey = key; return key; })
      .finally(() => { remintInFlight = null; });
  }
  return remintInFlight;
}

export async function revokeSimulatorKey(key: string): Promise<void> {
  // Revoke the caller's key plus any re-minted replacement, so a key swapped in
  // mid-run doesn't leak past cleanup. Duplicates are harmless.
  const keys = [...new Set([key, activeSimKey].filter((k): k is string => Boolean(k)))];
  activeSimKey = null;
  activeSimKeyOpts = null;
  await fetch(`${LITELLM_BASE_URL}/key/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LITELLM_MASTER_KEY}` },
    body: JSON.stringify({ keys }),
  }).catch(() => {});
}

export interface LlmUsage { promptTokens: number; completionTokens: number; costUsd: number }
export interface LlmResult { text: string; usage: LlmUsage }

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

/** Running total of simulator-side spend/tokens for the whole process. */
export const simSpend = { promptTokens: 0, completionTokens: 0, costUsd: 0, calls: 0 };

/** One OpenAI-compatible chat completion against the LiteLLM gateway using the
 *  simulator key. Returns text + usage; accumulates into simSpend. */
export async function simChat(
  simKey: string,
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number; model?: string } = {},
): Promise<LlmResult> {
  // Retry transient network / gateway blips (common under concurrency); never
  // retry quota/budget (terminal) or 4xx (bad request). One exception: an
  // expired key (401) is recoverable — re-mint once and retry, so a run that
  // outlives its key's TTL doesn't abort every remaining session.
  let key = currentSimKey(simKey);
  let res: Response | null = null;
  let lastErr: unknown;
  let remintedFor: string | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      res = await fetch(`${LITELLM_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: opts.model ?? SIM_MODEL,
          messages,
          max_tokens: opts.maxTokens ?? 700,
          temperature: opts.temperature ?? 0.7,
        }),
      });
      if (res.status >= 500 && res.status !== 501) { lastErr = new SimError(res.status, await res.text()); res = null; }
      else if (res.status === 401) {
        const body = await res.text();
        const err = new SimError(401, body);
        if (err.isExpired && remintedFor !== key) {
          remintedFor = key;
          key = await remintOnExpiry(key); // fresh key, then retry without counting an attempt
          res = null;
          continue;
        }
        throw err;
      }
      else break;
    } catch (e) { lastErr = e; res = null; } // network error (fetch failed)
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1) + 400));
  }
  if (!res) throw lastErr instanceof Error ? lastErr : new SimError(0, "simulator unreachable after retries");
  if (!res.ok) {
    const body = await res.text();
    throw new SimError(res.status, body);
  }
  const costHeader = res.headers.get("x-litellm-response-cost");
  const j = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = j.choices?.[0]?.message?.content ?? "";
  const usage: LlmUsage = {
    promptTokens: j.usage?.prompt_tokens ?? 0,
    completionTokens: j.usage?.completion_tokens ?? 0,
    costUsd: costHeader ? Number(costHeader) : 0,
  };
  simSpend.promptTokens += usage.promptTokens;
  simSpend.completionTokens += usage.completionTokens;
  simSpend.costUsd += usage.costUsd;
  simSpend.calls += 1;
  return { text, usage };
}

export class SimError extends Error {
  constructor(public httpStatus: number, public body: string) {
    super(`simulator LLM ${httpStatus}: ${body.slice(0, 200)}`);
  }
  get isQuota(): boolean {
    return /RateLimitError|RESOURCE_EXHAUSTED|quota|insufficient|budget|429|402/i.test(
      `${this.httpStatus} ${this.body}`,
    );
  }
  /** An expired virtual key — recoverable by re-minting (distinct from a bad key). */
  get isExpired(): boolean {
    return this.httpStatus === 401 && /expired_key|Expired Key|Key Expiry/i.test(this.body);
  }
}

/** Extract the first JSON object from a model reply that may be fenced or
 *  prefixed with prose. Returns null if nothing parseable is found. */
export function parseFirstJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates: string[] = [];
  if (fenced) candidates.push(fenced[1]!);
  const brace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (brace >= 0 && lastBrace > brace) candidates.push(text.slice(brace, lastBrace + 1));
  candidates.push(text);
  for (const c of candidates) {
    try { return JSON.parse(c.trim()) as T; } catch { /* try next */ }
  }
  return null;
}
