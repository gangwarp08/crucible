import { z } from "zod";

export const TelemetryEventTypeSchema = z.enum([
  "session.started",
  "session.ended",
  "llm.request",
  "llm.response",
  "sandbox.command",
  "sandbox.file_write",
  "candidate.message",
  "interviewer.message",
]);

export const TelemetryEventSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  type: TelemetryEventTypeSchema,
  /** Epoch ms */
  ts: z.number().int().positive(),
  /** Arbitrary structured payload — typed by each event type downstream */
  payload: z.record(z.string(), z.unknown()),
});

// ─── Integrity events (P1 — proctoring v1) ─────────────────────────────────
//
// Browser-reported, best-effort integrity signals. These flow into the same
// append-only `events` table but are a SEPARATE channel from competency
// evidence: they MUST NOT feed evidence extraction or evaluations — they
// inform the recruiter only (suspicion score, informational).

/** All browser-reported integrity event types. */
export const INTEGRITY_EVENT_TYPES = [
  "integrity.tab_blur",
  "integrity.tab_focus",
  "integrity.window_blur",
  "integrity.paste_burst",
  "integrity.idle_gap",
  "integrity.devtools",
  "integrity.copy",
  "integrity.fullscreen_exit",
  // P6.3 (proctoring v2) — webcam-presence signals. Emitted ONLY by consented
  // v2 sessions (lib/webcam-presence.ts); derived booleans, never pixels.
  "integrity.face_absent",
  "integrity.multiple_faces",
  // Geo/network slice — the browser's own timezone, emitted ONCE at session
  // start (lib/integrity.ts). Cross-checked server-side against the IP-derived
  // country (suspicion-score.ts geo_tz_mismatch). Informational, never scored.
  "integrity.client_env",
] as const;

export type IntegrityEventType = (typeof INTEGRITY_EVENT_TYPES)[number];

// ── SERVER-authored integrity events (geo/network slice) ────────────────────
//
// These ride the same integrity.* informational channel but are appended
// EXCLUSIVELY server-side (services/geo-integrity.ts via events-direct, actor
// "system") — they are derived from the connection the server itself observed,
// so a client-posted copy is by definition spoofed. They are deliberately NOT
// part of IntegrityEventSchema (the client-postable union): the ingest route
// rejects them with an explicit 400 (routes/integrity.ts) on top of the Zod
// rejection. Payloads carry DERIVED VALUES ONLY — a per-session-salted ip hash
// and a coarse geo country; the raw IP is never persisted or logged.
//
//   integrity.geo        {country, region, city, ip_hash}
//   integrity.ip_change  {change_count, prev_ip_hash, new_ip_hash,
//                         country_changed, new_country}
//
// (integrity.rate_capped, the P1.1 ingest-cap marker, is also server-authored
// and also outside the union — same posture.)
export const SERVER_INTEGRITY_EVENT_TYPES = [
  "integrity.geo",
  "integrity.ip_change",
  "integrity.rate_capped",
] as const;

export type ServerIntegrityEventType = (typeof SERVER_INTEGRITY_EVENT_TYPES)[number];

/** Client-clock epoch ms (informational; the server stamps its own ts). */
const ClientTs = z.number().int().positive().optional();

/** Payload-less signal events share this shape. */
const emptyPayload = z.object({}).strict().optional();

export const IntegrityEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("integrity.tab_blur"), ts: ClientTs, payload: emptyPayload }),
  z.object({ type: z.literal("integrity.tab_focus"), ts: ClientTs, payload: emptyPayload }),
  z.object({ type: z.literal("integrity.window_blur"), ts: ClientTs, payload: emptyPayload }),
  z.object({
    type: z.literal("integrity.paste_burst"),
    ts: ClientTs,
    payload: z.object({
      chars: z.number().int().min(1).max(1_000_000),
      target: z.enum(["editor", "chat", "message", "other"]),
    }),
  }),
  z.object({
    type: z.literal("integrity.idle_gap"),
    ts: ClientTs,
    payload: z.object({ ms: z.number().int().positive() }),
  }),
  z.object({ type: z.literal("integrity.devtools"), ts: ClientTs, payload: emptyPayload }),
  z.object({
    type: z.literal("integrity.copy"),
    ts: ClientTs,
    payload: z.object({
      source: z.enum(["brief", "docs", "other"]),
      chars: z.number().int().min(1).max(1_000_000),
    }),
  }),
  z.object({ type: z.literal("integrity.fullscreen_exit"), ts: ClientTs, payload: emptyPayload }),
  // P6.3 webcam-presence signals. Payloads are OPTIONAL: the shipped browser
  // heuristic emits signal-only events (no payload — it can't reliably measure
  // duration/count), but a richer client MAY attach the typed payload below.
  // Both shapes must validate — before P6 these types were Zod-REJECTED at
  // ingest (adversarial review HIGH #2).
  z.object({
    type: z.literal("integrity.face_absent"),
    ts: ClientTs,
    /** How long no one was visible, when the client can measure it. */
    payload: z.object({ ms: z.number().int().positive() }).strict().optional(),
  }),
  z.object({
    type: z.literal("integrity.multiple_faces"),
    ts: ClientTs,
    /** Faces detected (>= 2 by definition of the signal). */
    payload: z.object({ count: z.number().int().min(2).max(100) }).strict().optional(),
  }),
  // Geo/network slice — browser timezone snapshot, once per session start.
  // tz_name is the IANA zone from Intl.resolvedOptions().timeZone (null when
  // the browser can't report one); tz_offset_minutes is getTimezoneOffset()
  // (UTC−local, so UTC+5:30 reports -330; ±1440 is the representable bound).
  z.object({
    type: z.literal("integrity.client_env"),
    ts: ClientTs,
    payload: z
      .object({
        tz_offset_minutes: z.number().int().min(-1440).max(1440),
        tz_name: z.string().min(1).max(64).nullable(),
      })
      .strict(),
  }),
]);

export type IntegrityEvent = z.infer<typeof IntegrityEventSchema>;
