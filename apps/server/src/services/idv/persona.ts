// Persona (withpersona.com) IDV provider — DOCUMENTED STUB.
//
// Not implemented: no vendor contract yet. This file pins the integration
// shape so wiring it later is a fill-in, not a design exercise.
//
// INTEGRATION SHAPE (Persona API v1, verified against docs at authoring time —
// re-verify before implementing):
//   - Auth: `Authorization: Bearer <PERSONA_API_KEY>` against
//     https://api.withpersona.com/api/v1 (key would live in server env ONLY —
//     it is an IDV vendor credential, not a model-provider key, so Hard Rule 1
//     does not force it onto the gateway; it must still never reach the
//     browser or git).
//   - Flow (hosted): create an Inquiry (POST /inquiries, template with
//     government-id + selfie verifications) → redirect/embed the hosted flow →
//     receive `inquiry.completed` webhook (HMAC-SHA256 `Persona-Signature`
//     header) → GET /inquiries/:id to read verification results.
//   - Mapping to IdvResult:
//       matchConfidence ← selfie verification's face-match confidence
//       livenessScore   ← selfie verification's liveness check result
//   - DATA MINIMIZATION: fetch DERIVED results only; never download or store
//     the captured images from Persona; configure vendor-side retention to
//     the contractual minimum.
//
// Env (to add in env.ts when implementing): PERSONA_API_KEY,
// PERSONA_TEMPLATE_ID, PERSONA_WEBHOOK_SECRET.

import { IdvProviderError, type IdvProvider } from "./types.js";

export const personaProvider: IdvProvider = {
  name: "persona",
  async verifyIdentity(): Promise<never> {
    throw new IdvProviderError(
      "persona provider not configured — set IDV_PROVIDER=gateway-vision or implement services/idv/persona.ts (see header)",
    );
  },
};
