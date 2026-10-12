// Verification pipeline (slice V6) — signed, hash-chained provenance records.
//
// WHAT THIS PROVES: "this exact telemetry stream, this exact deliverable, and
// this identity-check result belong together, existed by session end, and
// asaya vouches for that binding." The events table is append-only with a
// monotonic per-session seq; chaining it (h_n = sha256(h_{n-1} ‖
// canonical(event_n))) produces a head hash that changes if ANY event is
// altered, dropped, or reordered. Signing the record that carries the head
// (plus the deliverable/identity hashes and score aggregates) makes the whole
// bundle third-party verifiable offline against our published public key.
//
// WHAT IT DOES NOT CONTAIN: raw telemetry, candidate content, biometrics —
// hashes and aggregates only (the cross-border-safe artifact; see 0029).
//
// KEYS: Ed25519 via node:crypto (no new dependency). The private key lives in
// env PROVENANCE_SIGNING_KEY (base64 PKCS8 DER) — generate with
// scripts/gen-provenance-key.ts. UNSET = provenance disabled: writes skip
// silently (fire-and-forget at session end), reads return what's stored.
// key_id = sha256(publicKeyDer)[:16] identifies the pair across rotations.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import { env } from "../env.js";
import { supabase } from "./supabase.js";
import {
  computeVerificationConfidence,
  VERIFICATION_CONFIDENCE_VERSION,
  type ConfidenceEventInput,
} from "./verification-confidence.js";
import { SUSPICION_DETECTOR_VERSION } from "./suspicion-score.js";
import { readIdentityStatus } from "./proctoring-v2.js";
import { readBgvForSession } from "./bgv/index.js";

export const PROVENANCE_RECORD_VERSION = 1;

export class ProvenanceError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ProvenanceError";
  }
}

// ── Canonicalization + hashing (pure; exported for verify script) ───────────

/** Deterministic JSON: object keys sorted recursively, arrays in order, no
 *  whitespace. Same input object → same bytes → same hash/signature. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(",")}}`;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Minimal event shape for chaining (the events-table row subset, seq-ordered). */
export interface ChainEventInput {
  seq: number;
  type: string;
  actor: string;
  ts: string;
  payload: Record<string, unknown> | null;
}

export const CHAIN_GENESIS = sha256Hex("crucible-provenance-v1");

/** Rolling hash chain over the seq-ordered event stream. */
export function chainEvents(events: ChainEventInput[]): { head: string; count: number } {
  const sorted = events.slice().sort((a, b) => a.seq - b.seq);
  let head = CHAIN_GENESIS;
  for (const e of sorted) {
    const canonical = canonicalize({
      seq: e.seq,
      type: e.type,
      actor: e.actor,
      ts: e.ts,
      payload: e.payload ?? {},
    });
    head = sha256Hex(head + canonical);
  }
  return { head, count: sorted.length };
}

// ── Keys ─────────────────────────────────────────────────────────────────────

interface KeyPairHandles {
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyBase64: string; // SPKI DER, base64
  keyId: string;
}

let cached: KeyPairHandles | null | undefined; // undefined = not resolved yet

/** Resolve the signing keypair from env. Null (disabled) when unset/invalid —
 *  invalid logs once and disables rather than crashing session teardown. */
export function getSigningKeys(): KeyPairHandles | null {
  if (cached !== undefined) return cached;
  const raw = env.PROVENANCE_SIGNING_KEY;
  if (!raw) {
    cached = null;
    return cached;
  }
  try {
    const privateKey = createPrivateKey({
      key: Buffer.from(raw, "base64"),
      format: "der",
      type: "pkcs8",
    });
    const publicKey = createPublicKey(privateKey);
    const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    cached = {
      privateKey,
      publicKey,
      publicKeyBase64: spki.toString("base64"),
      keyId: sha256Hex(spki.toString("base64")).slice(0, 16),
    };
  } catch (err) {
    console.error(
      "[provenance] PROVENANCE_SIGNING_KEY is not a valid base64 PKCS8 Ed25519 key — provenance disabled:",
      err instanceof Error ? err.message : String(err),
    );
    cached = null;
  }
  return cached;
}

/** Test hook — reset the key cache (env may be monkeypatched per fixture). */
export function __resetProvenanceKeys(): void {
  cached = undefined;
}

export function signRecord(record: unknown, privateKey: KeyObject): string {
  return edSign(null, Buffer.from(canonicalize(record)), privateKey).toString("base64");
}

export function verifyRecordSignature(
  record: unknown,
  signatureBase64: string,
  publicKeySpkiBase64: string,
): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeySpkiBase64, "base64"),
      format: "der",
      type: "spki",
    });
    return edVerify(
      null,
      Buffer.from(canonicalize(record)),
      publicKey,
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}

// ── Record assembly ──────────────────────────────────────────────────────────

export interface ProvenanceRecord {
  v: number;
  session_id: string;
  org_id: string;
  scenario_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  event_count: number;
  chain_head: string;
  /** sha256 of the canonical deliverable object; null when none submitted. */
  deliverable_hash: string | null;
  /** sha256 of the canonical derived identity-check row; null when none. */
  identity_hash: string | null;
  verification_confidence: {
    score: number | null;
    assessed_max: number;
    version: string;
  } | null;
  versions: Record<string, string>;
  /** V10: original-session record linkage for day-one reverify sessions. */
  reverify_of: string | null;
}

/**
 * Build the provenance record for a session from Supabase (events chained in
 * seq order via keyset pagination — the whole stream, not a capped page).
 * Pure data assembly; throws ProvenanceError on read failures.
 */
export async function buildProvenanceRecord(
  sessionId: string,
  extras: {
    verification: ProvenanceRecord["verification_confidence"];
    versions: Record<string, string>;
    reverifyOf?: string | null;
  },
): Promise<ProvenanceRecord> {
  if (!supabase) throw new ProvenanceError("Supabase unavailable");

  const { data: sess, error: sessErr } = await supabase
    .from("sessions")
    .select("id, org_id, scenario_id, started_at, ended_at, scenario_state")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessErr || !sess) throw new ProvenanceError(`session read failed: ${sessErr?.message ?? "not found"}`);
  const session = sess as {
    id: string; org_id: string; scenario_id: string | null;
    started_at: string | null; ended_at: string | null;
    scenario_state: Record<string, unknown> | null;
  };

  // Chain the FULL event stream (keyset pagination on seq — events is
  // append-only so pages are stable).
  let head = CHAIN_GENESIS;
  let count = 0;
  let afterSeq = -1;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await supabase
      .from("events")
      .select("seq, type, actor, ts, payload")
      .eq("session_id", sessionId)
      .gt("seq", afterSeq)
      .order("seq", { ascending: true })
      .limit(PAGE);
    if (error) throw new ProvenanceError(`events read failed: ${error.message}`);
    const rows = (data ?? []) as unknown as ChainEventInput[];
    if (rows.length === 0) break;
    for (const e of rows) {
      head = sha256Hex(
        head +
          canonicalize({ seq: e.seq, type: e.type, actor: e.actor, ts: e.ts, payload: e.payload ?? {} }),
      );
      count++;
      afterSeq = e.seq;
    }
    if (rows.length < PAGE) break;
  }

  const deliverable = session.scenario_state?.["deliverable"] ?? null;
  const deliverableHash = deliverable !== null ? sha256Hex(canonicalize(deliverable)) : null;

  // Identity hash: the DERIVED identity_checks row (never images — none exist).
  let identityHash: string | null = null;
  try {
    const { data: idRow } = await supabase
      .from("identity_checks")
      .select("session_id, decision, consent_text_version, match_confidence, verified, provider")
      .eq("session_id", sessionId)
      .maybeSingle();
    if (idRow) identityHash = sha256Hex(canonicalize(idRow));
  } catch {
    /* dormant pre-0024 — no identity hash */
  }

  return {
    v: PROVENANCE_RECORD_VERSION,
    session_id: session.id,
    org_id: session.org_id,
    scenario_id: session.scenario_id,
    started_at: session.started_at,
    ended_at: session.ended_at,
    event_count: count,
    chain_head: head,
    deliverable_hash: deliverableHash,
    identity_hash: identityHash,
    verification_confidence: extras.verification,
    versions: extras.versions,
    reverify_of: extras.reverifyOf ?? null,
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────

/**
 * Compute, sign, and store the session's provenance record. Fire-and-forget
 * from expireSession (after the final telemetry flush, so the chain covers
 * session.ended). Silent no-op when signing is disabled or the table is
 * absent; errors are logged, never thrown to the teardown path.
 */
export async function writeProvenanceRecord(
  sessionId: string,
  extras: Parameters<typeof buildProvenanceRecord>[1],
): Promise<void> {
  try {
    const keys = getSigningKeys();
    if (!keys || !supabase) return; // disabled — silent
    const record = await buildProvenanceRecord(sessionId, extras);
    const signature = signRecord(record, keys.privateKey);
    const { error } = await supabase.from("provenance_records").insert({
      session_id: sessionId,
      org_id: record.org_id,
      record,
      signature,
      key_id: keys.keyId,
    });
    if (error && error.code !== "23505" /* duplicate — idempotent re-end */) {
      // 42P01/PGRST205 (pre-0029) lands here too — log once per occurrence.
      console.error(`[provenance] record insert failed for ${sessionId}: ${error.message}`);
    }
  } catch (err) {
    console.error(
      `[provenance] record build failed for ${sessionId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Convenience glue for session teardown: computes the verification-confidence
 * aggregate from the session's informational events + identity status, then
 * writes the signed record. All failure paths are silent/logged — never
 * disturbs teardown.
 */
export async function writeProvenanceForSession(sessionId: string): Promise<void> {
  try {
    if (!getSigningKeys() || !supabase) return; // disabled — skip the reads too
    const [{ data: events }, identity, bgv] = await Promise.all([
      supabase
        .from("events")
        .select("seq, type, ts, payload")
        .eq("session_id", sessionId)
        .or("type.like.integrity.*,type.like.identity.*")
        .order("seq", { ascending: true })
        .limit(1000),
      readIdentityStatus(sessionId).catch(() => null),
      readBgvForSession(sessionId).catch(() => null),
    ]);
    const verification = computeVerificationConfidence(
      (events ?? []) as unknown as ConfidenceEventInput[],
      { faceMatchThreshold: env.FACE_MATCH_THRESHOLD, identity, bgv },
    );
    await writeProvenanceRecord(sessionId, {
      verification: {
        score: verification.score,
        assessed_max: verification.assessed_max,
        version: verification.version,
      },
      versions: {
        suspicion_detector: SUSPICION_DETECTOR_VERSION,
        verification_confidence: VERIFICATION_CONFIDENCE_VERSION,
      },
    });
  } catch (err) {
    console.error(
      `[provenance] teardown write failed for ${sessionId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export interface StoredProvenance {
  record: ProvenanceRecord;
  signature: string;
  key_id: string;
  created_at: string;
}

/** Read a session's stored provenance record; null when none / pre-0029. */
export async function readProvenanceRecord(sessionId: string): Promise<StoredProvenance | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("provenance_records")
      .select("record, signature, key_id, created_at")
      .eq("session_id", sessionId)
      .maybeSingle();
    if (error || !data) return null;
    return data as unknown as StoredProvenance;
  } catch {
    return null;
  }
}

/**
 * Integrity check for the review surface: re-derive the chain from today's
 * events and compare to the stored record. `chain_intact: false` means the
 * stream no longer reproduces the signed head (tampering, or data loss).
 */
export async function verifyStoredChain(stored: StoredProvenance): Promise<boolean> {
  try {
    const rebuilt = await buildProvenanceRecord(stored.record.session_id, {
      verification: stored.record.verification_confidence,
      versions: stored.record.versions,
      reverifyOf: stored.record.reverify_of,
    });
    return (
      rebuilt.chain_head === stored.record.chain_head &&
      rebuilt.event_count === stored.record.event_count
    );
  } catch {
    return false;
  }
}
