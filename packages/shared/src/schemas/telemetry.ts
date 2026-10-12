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
  // Verification slice (detector v5) — typing-dynamics window features.
  // Emitted ONLY by consented v2 sessions (lib/typing-dynamics.ts): aggregated
  // per-minute rhythm statistics (inter-key intervals, backspace ratio). The
  // raw keystroke stream — timings AND key identities — never leaves the
  // browser; key identity is never even recorded. Server-side drift detection
  // (services/typing-drift.ts) authors integrity.typing_drift from these.
  "integrity.typing_window",
  // Verification slice (detector v5) — environment-integrity signals.
  // display_change: the screen configuration changed (an extra display was
  // attached/present — a classic second-screen setup). Emitted once per state
  // change. virtual_camera: a capture device whose label matches a known
  // virtual-camera product class (OBS, ManyCam, …). Emitted at most once per
  // session, carries the matched CLASS, never the raw device label. Both are
  // best-effort heuristics; informational, never scored against competency.
  "integrity.display_change",
  "integrity.virtual_camera",
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
  // Verification slice (detector v5) — typing-rhythm step change, derived
  // server-side (services/typing-drift.ts) from the client's typing_window
  // feature stream. Server-authored: a client posting one is spoofing.
  //   integrity.typing_drift {baseline_mean_ms, window_mean_ms, windows}
  "integrity.typing_drift",
  // Verification continuity (dormant, consented v2 + anchor only) — derived
  // server-side (services/face-continuity.ts) by comparing the browser's
  // periodic sample EMBEDDING against the session's enrolment anchor. The
  // similarity is the only thing persisted; sample vectors are discarded.
  //   integrity.face_match    {similarity}       (one per compared sample)
  //   integrity.face_mismatch {similarity}       (streak below threshold)
  "integrity.face_match",
  "integrity.face_mismatch",
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
      // Verification slice (detector v5) — paste provenance. Where the pasted
      // text came from, judged client-side against a registry of text actually
      // rendered inside the sandbox (lib/paste-provenance.ts):
      //   internal — matches text the candidate saw in the workspace (docs,
      //              assistant replies, their own files) — benign;
      //   external — matches nothing rendered in the sandbox (the classic
      //              second-window signal);
      //   unknown  — partial/ambiguous match.
      // OPTIONAL for backward compatibility: pre-v5 clients omit it.
      provenance: z.enum(["internal", "external", "unknown"]).optional(),
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
  // Verification slice (detector v5) — typing-dynamics window features.
  // Aggregated rhythm statistics over a ~60s window; raw keystrokes (timing
  // and identity) never leave the browser. n is the keydown count in the
  // window (windows under the client's minimum are not posted).
  z.object({
    type: z.literal("integrity.typing_window"),
    ts: ClientTs,
    payload: z
      .object({
        n: z.number().int().min(1).max(10_000),
        mean_iki_ms: z.number().min(0).max(60_000),
        std_iki_ms: z.number().min(0).max(60_000),
        median_iki_ms: z.number().min(0).max(60_000),
        backspace_ratio: z.number().min(0).max(1),
        bursts: z.number().int().min(0).max(10_000),
        pauses: z.number().int().min(0).max(10_000),
      })
      .strict(),
  }),
  // Verification slice (detector v5) — environment integrity.
  // display_change: screen.isExtended flipped (or was true at mount). One
  // event per observed state change; `extended` is the NEW state.
  z.object({
    type: z.literal("integrity.display_change"),
    ts: ClientTs,
    payload: z.object({ extended: z.boolean() }).strict(),
  }),
  // virtual_camera: a videoinput device label matched a known virtual-camera
  // product class. The CLASS is a short identifier from a fixed client-side
  // list (e.g. "obs", "manycam") — never the raw device label (labels can
  // embed arbitrary user/device strings).
  z.object({
    type: z.literal("integrity.virtual_camera"),
    ts: ClientTs,
    payload: z.object({ label_class: z.string().min(1).max(32) }).strict(),
  }),
]);

export type IntegrityEvent = z.infer<typeof IntegrityEventSchema>;
