// Verification pipeline — IDV (identity verification) provider adapter layer.
//
// "Buy anything that verifies a document or a face against a database" — the
// IDV step is a swappable commodity. This interface is the seam: the default
// provider is our own gateway-vision compare (no vendor contract, Hard Rule 3
// compliant), and certified vendors (Persona, HyperVerge, …) plug in as
// alternative implementations selected by env IDV_PROVIDER without touching
// the proctoring service or routes.
//
// CONTRACT (every implementation MUST honor):
//   - Images are handled IN MEMORY ONLY: never persisted, never logged, never
//     echoed into error messages (vendor SDK error bodies can quote request
//     payloads — surface status/codes only).
//   - Returns DERIVED values only (confidence / liveness / verified), which
//     are the only things the caller stores (identity_checks, 0024 posture).
//   - Throws IdvProviderError on any failure; callers treat verification as
//     informational and never block the candidate on it.

export class IdvProviderError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "IdvProviderError";
  }
}

export interface IdvResult {
  /** Same-person confidence in [0,1]. */
  matchConfidence: number;
  /** Liveness confidence in [0,1] when the provider measures it (certified
   *  vendors do; the gateway-vision default does NOT — null there). */
  livenessScore: number | null;
}

export interface IdvProvider {
  /** Stable identifier persisted to identity_checks.provider. */
  readonly name: string;
  /**
   * Compare a government-ID photo against a live selfie (both data-URL JPEGs,
   * candidate-submitted). `sessionId` scopes any per-session budget/keying the
   * implementation needs (the gateway provider authenticates with the
   * session's own minted LiteLLM key).
   */
  verifyIdentity(idImage: string, selfieImage: string, sessionId: string): Promise<IdvResult>;
}
