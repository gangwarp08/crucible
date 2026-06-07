import { randomUUID } from "crypto";
import { sessionRegistry, type EventRecord } from "./registry.js";
import { supabase } from "./supabase.js";

const FLUSH_INTERVAL_MS = 250;
const FLUSH_HIGH_WATER = 50;

/**
 * Assign the next monotonic seq, buffer the event, and schedule a flush.
 * NEVER throws — telemetry must never block or break the request path.
 */
export function logEvent(
  sessionId: string,
  type: string,
  actor: string,
  payload: Record<string, unknown> = {},
): void {
  try {
    const entry = sessionRegistry.get(sessionId);
    if (!entry) return;

    const record: EventRecord = {
      id: randomUUID(),
      session_id: sessionId,
      seq: entry.nextSeq++,
      type,
      actor,
      ts: new Date().toISOString(),
      payload,
    };

    entry.eventBuffer.push(record);

    // Immediate flush on high-water mark.
    if (entry.eventBuffer.length >= FLUSH_HIGH_WATER) {
      void _flush(sessionId);
      return;
    }

    // Debounced flush — start timer only if not already running.
    if (entry.flushTimer === null) {
      entry.flushTimer = setTimeout(() => {
        void _flush(sessionId);
      }, FLUSH_INTERVAL_MS);
    }
  } catch (err) {
    console.error("[telemetry] logEvent error", err);
  }
}

/**
 * Drain the event buffer immediately. Call this at session end to ensure
 * all events are written before the process moves on to teardown.
 * NEVER throws.
 */
export async function flushTelemetry(sessionId: string): Promise<void> {
  try {
    const entry = sessionRegistry.get(sessionId);
    if (!entry) return;
    if (entry.flushTimer !== null) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
    }
    await _flush(sessionId);
  } catch (err) {
    console.error("[telemetry] flushTelemetry error", err);
  }
}

/** Internal: pop the buffer and insert into Supabase in one multi-row insert. */
async function _flush(sessionId: string): Promise<void> {
  const entry = sessionRegistry.get(sessionId);
  if (!entry || entry.eventBuffer.length === 0) return;

  entry.flushTimer = null;
  const batch = entry.eventBuffer.splice(0); // drain atomically

  if (!supabase) return; // Supabase not configured — drop silently

  const { error } = await supabase.from("events").insert(batch);
  if (error) {
    console.error("[telemetry] events insert failed", error.message);
    // Re-queue on failure so events aren't permanently lost on transient errors.
    entry.eventBuffer.unshift(...batch);
  }
}

// ---------------------------------------------------------------------------
// Stubs for 3.2 — these will be filled in once pty/file/chat sources are wired.
// ---------------------------------------------------------------------------

export async function recordTranscriptTurn(
  _sessionId: string,
  _role: "user" | "assistant",
  _content: string,
): Promise<void> {
  // TODO (3.2): INSERT into transcript table and emit candidate.message / interviewer.message event
}

export async function recordCost(
  _sessionId: string,
  _model: string,
  _promptTokens: number,
  _completionTokens: number,
  _costUsd: number,
): Promise<void> {
  // TODO (3.2): INSERT into cost_ledger and emit llm.response event
}

export async function recordFileSnapshot(
  _sessionId: string,
  _path: string,
  _content: string,
): Promise<void> {
  // TODO (3.2): INSERT into file_snapshots and emit sandbox.file_write event
}
