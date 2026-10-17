// HyperVerge IDV provider — DOCUMENTED STUB.
//
// Not implemented: no vendor contract yet. HyperVerge is the India-rail
// candidate (iBeta-certified passive liveness; offline-Aadhaar/DigiLocker
// consent flows; low-end-device tolerance). This file pins the integration
// shape so wiring it later is a fill-in, not a design exercise.
//
// INTEGRATION SHAPE (HyperVerge KYC API, verified against docs at authoring
// time — re-verify before implementing):
//   - Auth: appId/appKey headers against the regional endpoint
//     (https://ind.idv.hyperverge.co/v1 for India residency — keep Indian
//     candidates' biometric processing on the India region per DPDP posture).
//     Credentials live in server env ONLY; never the browser, never git.
//   - Flow (API): POST face-match with the two images (multipart) →
//     synchronous result {match: yes/no, confidence}; POST liveness with the
//     selfie → {live: yes/no, confidence}. (A hosted-workflow variant exists;
//     the direct API maps cleaner onto IdvProvider.)
//   - Mapping to IdvResult:
//       matchConfidence ← face-match confidence (normalized 0..1)
//       livenessScore   ← liveness confidence (normalized 0..1)
//   - DATA MINIMIZATION: send the two candidate-submitted frames, store
//     DERIVED results only, contractual zero-retention on the vendor side
//     where available.
//
// Env (to add in env.ts when implementing): HYPERVERGE_APP_ID,
// HYPERVERGE_APP_KEY, HYPERVERGE_REGION.

import { IdvProviderError, type IdvProvider } from "./types.js";

export const hypervergeProvider: IdvProvider = {
  name: "hyperverge",
  async verifyIdentity(): Promise<never> {
    throw new IdvProviderError(
      "hyperverge provider not configured — set IDV_PROVIDER=gateway-vision or implement services/idv/hyperverge.ts (see header)",
    );
  },
};
