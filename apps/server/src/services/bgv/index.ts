// BGV provider registry + DB orchestration (slice V9).
//
// VENDOR UPGRADE PATH (documented stubs, same philosophy as services/idv/):
//   truework (US): REST + webhook; create a Verification of Employment via
//     POST /verification-requests with the candidate's consent token; results
//     arrive on a signed webhook. Env to add: TRUEWORK_API_KEY.
//   ongrid / authbridge / idfy (India): EPFO-linked employment + DigiLocker
//     education; API-key auth; sync-or-webhook per product. Pick the vendor on
//     offline-Aadhaar capability first (see docs). Env per vendor.
// Each becomes one adapter file implementing BgvProvider; selection stays here.

import { env } from "../../env.js";
import { supabase } from "../supabase.js";
import type { BgvProvider, BgvRequest, BgvResults } from "./types.js";
import { BgvProviderError } from "./types.js";
import { stubBgvProvider } from "./stub.js";

export * from "./types.js";
export { stubBgvProvider } from "./stub.js";

const PROVIDERS: Record<string, BgvProvider> = {
  stub: stubBgvProvider,
};

export function getBgvProvider(): BgvProvider {
  const name = env.BGV_PROVIDER ?? "stub";
  const provider = PROVIDERS[name];
  if (!provider) {
    console.warn(`[bgv] unknown BGV_PROVIDER "${name}" — falling back to stub`);
    return stubBgvProvider;
  }
  return provider;
}

export class BgvError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BgvError";
  }
}

export interface BgvCheckRow {
  id: string;
  org_id: string;
  candidate_label: string;
  session_link_id: string | null;
  provider: string;
  status: "queued" | "pending" | "complete" | "failed";
  checks: string[];
  results: BgvResults | null;
  external_ref: string | null;
  created_at: string;
  updated_at: string;
}

/** True when every result in the set came back clear. Null for empty/absent
 *  results (nothing verifiable → not a clear). */
export function isClear(results: BgvResults | null): boolean | null {
  if (!results) return null;
  const entries = Object.values(results);
  if (entries.length === 0) return null;
  return entries.every((r) => r.status === "clear");
}

/** Create a check request: provider call first, then the row (status complete
 *  immediately for inline/stub providers, pending for webhook vendors). */
export async function requestBgvCheck(
  orgId: string,
  req: BgvRequest,
  sessionLinkId: string | null,
): Promise<BgvCheckRow> {
  if (!supabase) throw new BgvError("Supabase unavailable");
  const provider = getBgvProvider();
  const outcome = await provider.requestCheck(req);

  const row = {
    org_id: orgId,
    candidate_label: req.candidateLabel,
    session_link_id: sessionLinkId,
    provider: provider.name,
    status: outcome.inlineResults ? "complete" : "pending",
    checks: req.checks,
    results: outcome.inlineResults,
    external_ref: outcome.externalRef,
  };
  const { data, error } = await supabase.from("bgv_checks").insert(row).select("*").maybeSingle();
  if (error || !data) throw new BgvError(`bgv_checks insert failed: ${error?.message ?? "no row"}`);
  return data as unknown as BgvCheckRow;
}

export async function readBgvCheck(id: string): Promise<BgvCheckRow | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from("bgv_checks").select("*").eq("id", id).maybeSingle();
  if (error || !data) return null;
  return data as unknown as BgvCheckRow;
}

/** Apply a vendor webhook: parse via the adapter, update by external_ref. */
export async function applyBgvWebhook(providerName: string, payload: unknown): Promise<boolean> {
  if (!supabase) throw new BgvError("Supabase unavailable");
  const provider = PROVIDERS[providerName];
  if (!provider) throw new BgvProviderError(`unknown provider "${providerName}"`);
  const { externalRef, results } = provider.parseWebhook(payload);
  const { data, error } = await supabase
    .from("bgv_checks")
    .update({ results, status: "complete", updated_at: new Date().toISOString() })
    .eq("external_ref", externalRef)
    .eq("provider", providerName)
    .select("id");
  if (error) throw new BgvError(`bgv_checks update failed: ${error.message}`);
  return (data ?? []).length > 0;
}

/**
 * BGV summary for a SESSION (feeds the verification-confidence bgv component):
 * session → its session_link → latest check for (org, candidate_label).
 * Null on every absent path (no link, no checks, pre-0028) — not_assessed.
 */
export async function readBgvForSession(
  sessionId: string,
): Promise<{ status: "complete" | "pending" | "failed"; clear: boolean | null } | null> {
  if (!supabase) return null;
  try {
    const { data: link } = await supabase
      .from("session_links")
      .select("org_id, candidate_label")
      .eq("session_id", sessionId)
      .maybeSingle();
    const l = link as { org_id?: string; candidate_label?: string } | null;
    if (!l?.org_id || !l.candidate_label) return null;

    const { data: check } = await supabase
      .from("bgv_checks")
      .select("status, results")
      .eq("org_id", l.org_id)
      .eq("candidate_label", l.candidate_label)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const c = check as { status?: string; results?: BgvResults | null } | null;
    if (!c?.status || c.status === "queued") return null;
    return {
      status: c.status as "complete" | "pending" | "failed",
      clear: c.status === "complete" ? isClear(c.results ?? null) : null,
    };
  } catch {
    return null; // pre-0028 / any read failure → not_assessed
  }
}
