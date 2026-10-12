// Verification pipeline (slice V6) — public provenance key endpoint.
//
//   GET /api/provenance/public-key   (public, unauthenticated)
//
// Serves the Ed25519 public key (SPKI DER, base64) + key id so third parties
// can verify a provenance record offline:
//   verify(Ed25519, canonicalJson(record), base64decode(signature), publicKey)
// where canonicalJson = recursively-sorted-keys JSON with no whitespace
// (services/provenance.ts canonicalize). Registered without a prefix — the
// full path is spelled out here.

import type { FastifyInstance } from "fastify";
import { getSigningKeys, PROVENANCE_RECORD_VERSION } from "../services/provenance.js";

export async function provenanceRoutes(server: FastifyInstance) {
  server.get(
    "/api/provenance/public-key",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (_request, reply) => {
      const keys = getSigningKeys();
      if (!keys) {
        // Signing not configured on this deploy — explicit, cacheable answer.
        return reply.status(404).send({ error: "provenance_disabled" });
      }
      return reply.send({
        key_id: keys.keyId,
        algorithm: "Ed25519",
        public_key_spki_base64: keys.publicKeyBase64,
        record_version: PROVENANCE_RECORD_VERSION,
        canonicalization: "sorted-keys JSON, no whitespace (see docs)",
      });
    },
  );
}
