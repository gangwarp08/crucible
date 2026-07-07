import { randomUUID, createHash } from "crypto";
import { sessionRegistry, type EventRecord } from "./registry.js";
import { supabase } from "./supabase.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FLUSH_INTERVAL_MS = 250;
const FLUSH_HIGH_WATER = 50;
const PTY_FLUSH_MS = 250;
const PTY_HIGH_WATER_BYTES = 4 * 1024; // 4 KB

// ---------------------------------------------------------------------------
// Core event buffer — shared seq counter keeps ALL event types globally ordered
// ---------------------------------------------------------------------------

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

    if (entry.eventBuffer.length >= FLUSH_HIGH_WATER) {
      void _flushEvents(sessionId);
      return;
    }
    if (entry.flushTimer === null) {
      entry.flushTimer = setTimeout(() => { void _flushEvents(sessionId); }, FLUSH_INTERVAL_MS);
    }
  } catch (err) {
    console.error("[telemetry] logEvent error", err);
  }
}

/** Drain everything — PTY buffers first (they produce events), then the event buffer. */
export async function flushTelemetry(sessionId: string): Promise<void> {
  try {
    // PTY buffers call logEvent, so flush them first to funnel into the event buffer.
    _flushPtyBuffer(sessionId, "output");
    _flushPtyBuffer(sessionId, "input");

    const entry = sessionRegistry.get(sessionId);
    if (!entry) return;
    if (entry.flushTimer !== null) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
    }
    await _flushEvents(sessionId);
  } catch (err) {
    console.error("[telemetry] flushTelemetry error", err);
  }
}

async function _flushEvents(sessionId: string): Promise<void> {
  const entry = sessionRegistry.get(sessionId);
  if (!entry || entry.eventBuffer.length === 0) return;
  entry.flushTimer = null;
  const batch = entry.eventBuffer.splice(0);
  if (!supabase) return;
  const { error } = await supabase.from("events").insert(batch);
  if (error) {
    console.error("[telemetry] events insert failed", error.message);
    entry.eventBuffer.unshift(...batch);
  }
}

// ---------------------------------------------------------------------------
// PTY stream batching
// ---------------------------------------------------------------------------

/**
 * Append incoming PTY bytes to the per-direction buffer, flushing when the
 * 4 KB high-water mark is reached or the 250 ms debounce timer fires.
 */
export function appendPtyData(
  sessionId: string,
  direction: "output" | "input",
  data: Buffer,
): void {
  try {
    const entry = sessionRegistry.get(sessionId);
    if (!entry || entry.status === "completed") return;

    const buf = direction === "output" ? entry.ptyOutputBuffer : entry.ptyInputBuffer;
    buf.push(data);

    const bytesKey = direction === "output" ? "ptyOutputBytes" : "ptyInputBytes";
    entry[bytesKey] += data.length;
    if (entry[bytesKey] >= PTY_HIGH_WATER_BYTES) {
      _flushPtyBuffer(sessionId, direction);
      return;
    }

    const timerKey = direction === "output" ? "ptyOutputFlushTimer" : "ptyInputFlushTimer";
    if (entry[timerKey] === null) {
      entry[timerKey] = setTimeout(() => { _flushPtyBuffer(sessionId, direction); }, PTY_FLUSH_MS);
    }
  } catch (err) {
    console.error("[telemetry] appendPtyData error", err);
  }
}

/** Flush both PTY buffers — called at session end before the event drain. */
export function flushAllPtyBuffers(sessionId: string): void {
  _flushPtyBuffer(sessionId, "output");
  _flushPtyBuffer(sessionId, "input");
}

function _flushPtyBuffer(sessionId: string, direction: "output" | "input"): void {
  const entry = sessionRegistry.get(sessionId);
  if (!entry) return;

  const timerKey = direction === "output" ? "ptyOutputFlushTimer" : "ptyInputFlushTimer";
  if (entry[timerKey] !== null) {
    clearTimeout(entry[timerKey]!);
    entry[timerKey] = null;
  }

  const buf = direction === "output" ? entry.ptyOutputBuffer : entry.ptyInputBuffer;
  if (buf.length === 0) return;

  const combined = Buffer.concat(buf);
  buf.length = 0; // drain in-place
  entry[direction === "output" ? "ptyOutputBytes" : "ptyInputBytes"] = 0;

  const type = direction === "output" ? "pty.output" : "pty.input";
  const actor = direction === "output" ? "system" : "candidate";
  logEvent(sessionId, type, actor, {
    data: combined.toString("base64"),
    bytes: combined.length,
  });
}

// ---------------------------------------------------------------------------
// File snapshots
// ---------------------------------------------------------------------------

/**
 * Write a file snapshot row and emit a file.write event.
 * Skips silently if the content hash matches the last write for this path (dedup).
 */
export async function recordFileSnapshot(
  sessionId: string,
  path: string,
  content: string,
): Promise<void> {
  try {
    const entry = sessionRegistry.get(sessionId);
    if (!entry) return;

    const hash = createHash("sha256").update(content).digest("hex");
    const previousHash = entry.lastFileHashes.get(path);

    if (previousHash === hash) return; // no-op dedup

    const action = previousHash === undefined ? "create" : "write";
    entry.lastFileHashes.set(path, hash);

    const sizeBytes = Buffer.byteLength(content, "utf8");

    if (supabase) {
      const { error } = await supabase.from("file_snapshots").insert({
        session_id: sessionId,
        path,
        content,
        action,
        size_bytes: sizeBytes,
        content_hash: hash,
      });
      if (error) console.error("[telemetry] file_snapshots insert failed", error.message);
    }

    logEvent(sessionId, "file.write", "candidate", { path, action, size_bytes: sizeBytes, hash });
  } catch (err) {
    console.error("[telemetry] recordFileSnapshot error", err);
  }
}

// ---------------------------------------------------------------------------
// Transcript + cost
// ---------------------------------------------------------------------------

interface TranscriptMeta {
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  finishReason?: string;
  litellmCallId?: string;
  /** Pre-generated UUID — lets the caller link cost_ledger without awaiting. */
  transcriptId?: string;
}

/**
 * Insert a transcript row (system/user/assistant) and — for user/assistant turns —
 * emit a lightweight chat.user / chat.assistant marker into the global events timeline.
 * Returns the transcript row UUID (pre-generated or freshly minted).
 * NEVER throws.
 */
export async function recordTranscriptTurn(
  sessionId: string,
  role: "system" | "user" | "assistant",
  content: string,
  meta: TranscriptMeta = {},
): Promise<string> {
  const id = meta.transcriptId ?? randomUUID();
  try {
    const entry = sessionRegistry.get(sessionId);
    if (!entry) return id;

    const seq = entry.nextTranscriptSeq++;

    if (supabase) {
      const row: Record<string, unknown> = { id, session_id: sessionId, seq, role, content };
      if (meta.model)              row.model = meta.model;
      if (meta.promptTokens != null)    row.prompt_tokens = meta.promptTokens;
      if (meta.completionTokens != null) row.completion_tokens = meta.completionTokens;
      if (meta.totalTokens != null)     row.total_tokens = meta.totalTokens;
      if (meta.costUsd != null)         row.cost_usd = meta.costUsd;
      if (meta.latencyMs != null)       row.latency_ms = meta.latencyMs;
      if (meta.finishReason)            row.finish_reason = meta.finishReason;
      if (meta.litellmCallId)           row.litellm_call_id = meta.litellmCallId;

      const { error } = await supabase.from("transcript").insert(row);
      if (error) console.error("[telemetry] transcript insert failed", error.message);
    }

    // Lightweight event marker — the full text lives in transcript, NOT in events.
    if (role !== "system") {
      const type = role === "user" ? "chat.user" : "chat.assistant";
      const actor = role === "user" ? "candidate" : "system";
      logEvent(sessionId, type, actor, { transcript_id: id, seq });
    }
  } catch (err) {
    console.error("[telemetry] recordTranscriptTurn error", err);
  }
  return id;
}

/**
 * Insert one cost_ledger row per assistant call.
 * Links to the assistant's transcript row via transcript_id. NEVER throws.
 */
export async function recordCost(
  sessionId: string,
  opts: {
    model: string;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    cumulativeSpendUsd: number;
    purpose?: string;
    litellmCallId?: string;
    transcriptId?: string;
  },
): Promise<void> {
  try {
    if (!supabase) return;
    const { error } = await supabase.from("cost_ledger").insert({
      session_id: sessionId,
      model: opts.model,
      prompt_tokens: opts.promptTokens,
      completion_tokens: opts.completionTokens,
      cost_usd: opts.costUsd,
      cumulative_spend_usd: opts.cumulativeSpendUsd,
      purpose: opts.purpose ?? "chat",
      litellm_call_id: opts.litellmCallId ?? null,
      transcript_id: opts.transcriptId ?? null,
    });
    if (error) console.error("[telemetry] cost_ledger insert failed", error.message);
  } catch (err) {
    console.error("[telemetry] recordCost error", err);
  }
}
