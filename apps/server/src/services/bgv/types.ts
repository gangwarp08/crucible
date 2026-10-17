// Verification pipeline (slice V9) — BGV (claims verification) adapter layer.
//
// Stage-1 intake "buy" plug-in, same seam philosophy as services/idv/: the
// BgvProvider interface is what the routes and the confidence score talk to;
// vendors (Truework/Argyle US, OnGrid/AuthBridge/IDfy India) are adapter
// implementations selected by env BGV_PROVIDER. The deterministic stub ships
// first so the whole pipeline is buildable and testable with no contract.
//
// CONTRACT:
//   - Candidates are identified by the pseudonymous candidate_label only;
//     anything more (legal name, employer ids) is the implementing adapter's
//     concern and must stay out of our tables (bgv_checks stores derived
//     results only, never documents).
//   - Async by shape: requestCheck returns an external_ref; results arrive via
//     webhook (routes/bgv.ts) or provider polling. The STUB resolves
//     synchronously by returning results inline (completesInline = true).

export type BgvCheckType = "employment" | "education";

export type BgvCheckOutcome = "clear" | "discrepancy" | "unable_to_verify";

export interface BgvCheckResult {
  status: BgvCheckOutcome;
  note: string;
}

export type BgvResults = Partial<Record<BgvCheckType, BgvCheckResult>>;

export interface BgvRequest {
  candidateLabel: string;
  checks: BgvCheckType[];
}

export interface BgvRequestOutcome {
  externalRef: string;
  /** Stub/synchronous providers return results immediately; real vendors
   *  return null here and deliver via webhook. */
  inlineResults: BgvResults | null;
}

export class BgvProviderError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BgvProviderError";
  }
}

export interface BgvProvider {
  /** Stable identifier persisted to bgv_checks.provider. */
  readonly name: string;
  requestCheck(req: BgvRequest): Promise<BgvRequestOutcome>;
  /** Normalize a vendor webhook payload into {externalRef, results}. Throws
   *  BgvProviderError on an unrecognizable payload. */
  parseWebhook(payload: unknown): { externalRef: string; results: BgvResults };
}
