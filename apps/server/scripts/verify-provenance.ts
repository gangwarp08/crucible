/**
 * verify-provenance.ts — slice V6 acceptance.
 *
 * Deterministic, infra-light: exercises the pure chain/sign/verify core in
 * src/services/provenance.ts with an in-memory keypair (the Supabase-touching
 * build/write paths are covered by the live E2E pass).
 *
 * Acceptance:
 *   - canonicalize: key order + whitespace invariant, arrays ordered,
 *     undefined dropped;
 *   - chainEvents: deterministic; sensitive to any event mutation, drop, or
 *     reorder; genesis for the empty stream;
 *   - sign/verify: a signed record verifies against the public key; ANY field
 *     tamper (score bump, hash swap) fails verification; wrong key fails.
 *
 * Run: pnpm --filter @crucible/server exec tsx scripts/verify-provenance.ts
 */
import { generateKeyPairSync } from "node:crypto";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const {
  canonicalize,
  sha256Hex,
  chainEvents,
  CHAIN_GENESIS,
  signRecord,
  verifyRecordSignature,
} = await import("../src/services/provenance.js");

let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  if (!ok) failed++;
}

console.log("verify-provenance — slice V6\n");

// ── [a] canonicalization ─────────────────────────────────────────────────────
{
  console.log("[a] canonicalization");
  check(
    "key order invariant",
    canonicalize({ b: 1, a: { d: 2, c: 3 } }) === canonicalize({ a: { c: 3, d: 2 }, b: 1 }),
  );
  check("arrays keep order", canonicalize([1, 2]) !== canonicalize([2, 1]));
  check("undefined keys dropped", canonicalize({ a: 1, b: undefined }) === '{"a":1}');
  check("null preserved", canonicalize({ a: null }) === '{"a":null}');
  check("stable hash", sha256Hex(canonicalize({ x: 1 })) === sha256Hex('{"x":1}'));
}

// ── [b] event chain ──────────────────────────────────────────────────────────
const T = "2026-10-11T10:00:00.000Z";
const events = [
  { seq: 1, type: "session.created", actor: "system", ts: T, payload: {} },
  { seq: 2, type: "chat.user", actor: "candidate", ts: T, payload: { transcript_id: "t1" } },
  { seq: 3, type: "deliverable.submit", actor: "candidate", ts: T, payload: { ok: true } },
  { seq: 4, type: "session.ended", actor: "system", ts: T, payload: { endReason: "manual" } },
];
{
  console.log("\n[b] event chain");
  const { head, count } = chainEvents(events);
  check("deterministic", chainEvents(events).head === head);
  check("count = 4", count === 4);
  check("empty stream → genesis", chainEvents([]).head === CHAIN_GENESIS);

  const tampered = events.map((e) =>
    e.seq === 3 ? { ...e, payload: { ok: false } } : e,
  );
  check("payload tamper changes head", chainEvents(tampered).head !== head);

  const dropped = events.filter((e) => e.seq !== 2);
  check("dropped event changes head", chainEvents(dropped).head !== head);

  // chainEvents sorts by seq, so a REORDERED ARRAY of the same events chains
  // identically (seq is the order authority)…
  const shuffled = [events[2]!, events[0]!, events[3]!, events[1]!];
  check("array order irrelevant (seq is authority)", chainEvents(shuffled).head === head);
  // …but swapping the seq numbers of two events IS a reorder and must change
  // the head.
  const seqSwapped = events.map((e) =>
    e.seq === 2 ? { ...e, seq: 3 } : e.seq === 3 ? { ...e, seq: 2 } : e,
  );
  check("seq swap changes head", chainEvents(seqSwapped).head !== head);
}

// ── [c] sign / verify ────────────────────────────────────────────────────────
{
  console.log("\n[c] sign / verify");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64");

  const record = {
    v: 1,
    session_id: "11111111-1111-1111-1111-111111111111",
    chain_head: chainEvents(events).head,
    event_count: 4,
    deliverable_hash: sha256Hex(canonicalize({ summary: "answer" })),
    verification_confidence: { score: 82, assessed_max: 100, version: "1" },
  };
  const sig = signRecord(record, privateKey);
  check("signature verifies", verifyRecordSignature(record, sig, spki));
  check(
    "score tamper fails",
    !verifyRecordSignature({ ...record, verification_confidence: { ...record.verification_confidence, score: 99 } }, sig, spki),
  );
  check(
    "chain-head tamper fails",
    !verifyRecordSignature({ ...record, chain_head: sha256Hex("forged") }, sig, spki),
  );
  const other = generateKeyPairSync("ed25519");
  const otherSpki = (other.publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64");
  check("wrong public key fails", !verifyRecordSignature(record, sig, otherSpki));
  check("garbage signature fails", !verifyRecordSignature(record, "AAAA", spki));
}

console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
