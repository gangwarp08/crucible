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
] as const;

export type IntegrityEventType = (typeof INTEGRITY_EVENT_TYPES)[number];

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
]);

export type IntegrityEvent = z.infer<typeof IntegrityEventSchema>;
