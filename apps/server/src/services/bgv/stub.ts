// Deterministic stub BGV provider — the default until a vendor contract
// exists. Lets the full request → result → confidence-component pipeline run
// end-to-end (and the robustness harness exercise discrepancy paths) with no
// network and no PII.
//
// DETERMINISM RULE: the outcome derives from the candidate_label so fixtures
// are reproducible —
//   label contains "discrepancy" → every check returns discrepancy;
//   label contains "unverifiable" → unable_to_verify;
//   anything else → clear.

import { createHash } from "node:crypto";
import type { BgvProvider, BgvResults, BgvCheckType, BgvCheckResult } from "./types.js";
import { BgvProviderError } from "./types.js";

function outcomeFor(label: string): BgvCheckResult {
  if (/discrepancy/i.test(label)) {
    return { status: "discrepancy", note: "stub: label requested a discrepancy outcome" };
  }
  if (/unverifiable/i.test(label)) {
    return { status: "unable_to_verify", note: "stub: label requested an unverifiable outcome" };
  }
  return { status: "clear", note: "stub: deterministic clear" };
}

export const stubBgvProvider: BgvProvider = {
  name: "stub",

  async requestCheck(req) {
    const results: BgvResults = {};
    for (const check of req.checks) results[check] = outcomeFor(req.candidateLabel);
    return {
      // Stable per (label, checks) so repeated requests correlate in fixtures.
      externalRef:
        "stub-" +
        createHash("sha256")
          .update(`${req.candidateLabel}|${[...req.checks].sort().join(",")}`)
          .digest("hex")
          .slice(0, 16),
      inlineResults: results, // synchronous — no webhook leg needed
    };
  },

  parseWebhook(payload) {
    // The stub never sends webhooks, but accepts its own shape for tests:
    // { external_ref, results: { employment: {status, note}, ... } }
    if (typeof payload !== "object" || payload === null) {
      throw new BgvProviderError("stub webhook: payload not an object");
    }
    const o = payload as Record<string, unknown>;
    if (typeof o["external_ref"] !== "string" || typeof o["results"] !== "object" || o["results"] === null) {
      throw new BgvProviderError("stub webhook: missing external_ref/results");
    }
    const raw = o["results"] as Record<string, unknown>;
    const results: BgvResults = {};
    for (const key of ["employment", "education"] as BgvCheckType[]) {
      const r = raw[key];
      if (typeof r === "object" && r !== null) {
        const rr = r as Record<string, unknown>;
        if (rr["status"] === "clear" || rr["status"] === "discrepancy" || rr["status"] === "unable_to_verify") {
          results[key] = {
            status: rr["status"],
            note: typeof rr["note"] === "string" ? rr["note"] : "",
          };
        }
      }
    }
    return { externalRef: o["external_ref"], results };
  },
};
