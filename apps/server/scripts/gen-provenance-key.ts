/**
 * gen-provenance-key.ts — mint the Ed25519 provenance signing keypair (V6).
 *
 * Prints:
 *   - PROVENANCE_SIGNING_KEY (base64 PKCS8 DER private key) → set in the
 *     server's env (Railway). NEVER commit it; never NEXT_PUBLIC_.
 *   - the public key (base64 SPKI DER) + key id — served by
 *     GET /api/provenance/public-key; safe to publish anywhere.
 *
 * Rotation: mint a new pair, swap the env var, keep old PUBLIC keys published
 * (records carry key_id, so old records stay verifiable against the old key).
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/gen-provenance-key.ts
 */
import { generateKeyPairSync, createHash } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const pkcs8 = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64");
const spki = (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64");
const keyId = createHash("sha256").update(spki).digest("hex").slice(0, 16);

console.log("Ed25519 provenance signing keypair\n");
console.log("PROVENANCE_SIGNING_KEY (SECRET — server env only):\n");
console.log(`  ${pkcs8}\n`);
console.log("Public key (SPKI DER base64 — publish freely):\n");
console.log(`  ${spki}\n`);
console.log(`key_id: ${keyId}`);
