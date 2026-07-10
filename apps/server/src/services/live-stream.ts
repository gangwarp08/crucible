// Live session monitoring — read-only SSE feed (recruiter/admin "Watch live").
//
// There is NO in-memory event bus on the session registry (see registry.ts:
// events are buffered on the SessionEntry and flushed to Supabase in batches),
// so a live watcher can't subscribe to an emitter. Instead this module POLLS
// the events table for new rows (seq > lastSeq) on a fixed cadence, plus the
// sessions row for status/spend/deadline changes. The events table has a
// monotonic per-session seq (events_session_seq index), so "new rows since
// lastSeq" is a cheap, ordered, gap-free tail.
//
// READ-ONLY: this module never writes. It is org-scoped by its caller (the
// review route gates visibility via sessionOrgGate before opening the stream).

import { supabase } from "./supabase.js";

/** The non-terminal (still-running) session statuses — the single source of
 *  truth mirrored from deadline-reaper.ts. A session is "live"/watchable while
 *  its status is in this set; anything else is terminal. Modelling it as a
 *  non-terminal allow-list (rather than a terminal deny-list) matters: the
 *  reaper writes "timed_out" on a deadline miss and finalizeSession writes
 *  "completed"/"timed_out" (plus future error states) — a terminal deny-list of
 *  just "completed" would leave a timed-out or errored session streaming until
 *  the lifetime cap and never emit `end`. */
const NON_TERMINAL_STATUSES = new Set(["active", "submitted", "defending"]);

/** Terminal status — the session has ended and no more rows will arrive. Any
 *  status that is NOT a known non-terminal one (completed / timed_out / errored
 *  / …). null/undefined is treated as non-terminal (unknown, keep watching). */
export function isTerminalStatus(status: string | null | undefined): boolean {
  return status != null && !NON_TERMINAL_STATUSES.has(status);
}

/** A session is "live" (watchable) while it is running/active. */
export function isLiveStatus(status: string | null | undefined): boolean {
  return status != null && NON_TERMINAL_STATUSES.has(status);
}

export interface LiveStatusSnapshot {
  status: string | null;
  spend_usd: number;
  budget_usd: number;
  deadline: string | null;
  ended_at: string | null;
}

export interface LiveEventRow {
  seq: number;
  type: string;
  actor: string;
  payload: Record<string, unknown>;
  created_at: string;
}

/** Max rows returned per poll — bounds the payload if a watcher joins a busy
 *  session far behind, or catches up from ?since=0 on a long session. The
 *  poller keeps advancing lastSeq, so the next tick fetches the next batch. */
export const LIVE_EVENT_BATCH = 200;
/** Poll cadence for both the events tail and the status snapshot. */
export const LIVE_POLL_INTERVAL_MS = 1000;

/** Read the current status snapshot for a session (status + budget/spend +
 *  deadline). Returns null when the row is gone or Supabase is unavailable. */
export async function readLiveStatus(
  sessionId: string,
): Promise<LiveStatusSnapshot | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("sessions")
    .select("status, spend_usd, budget_usd, deadline, ended_at")
    .eq("id", sessionId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as {
    status: string | null;
    spend_usd: number | string | null;
    budget_usd: number | string | null;
    deadline: string | null;
    ended_at: string | null;
  };
  return {
    status: row.status,
    spend_usd: Number(row.spend_usd ?? 0),
    budget_usd: Number(row.budget_usd ?? 0),
    deadline: row.deadline ?? null,
    ended_at: row.ended_at ?? null,
  };
}

/** Fetch up to LIVE_EVENT_BATCH events with seq > sinceSeq, ascending. The
 *  events table's `ts` column is the row timestamp (there is no created_at);
 *  it is surfaced to the client as created_at to match the review contract. */
export async function readEventsSince(
  sessionId: string,
  sinceSeq: number,
): Promise<LiveEventRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("events")
    .select("seq, type, actor, payload, ts")
    .eq("session_id", sessionId)
    .gt("seq", sinceSeq)
    .order("seq", { ascending: true })
    .limit(LIVE_EVENT_BATCH);
  if (error || !data) return [];
  return (data as Array<{
    seq: number;
    type: string;
    actor: string;
    payload: Record<string, unknown> | null;
    ts: string;
  }>).map((r) => ({
    seq: r.seq,
    type: r.type,
    actor: r.actor,
    payload: r.payload ?? {},
    created_at: r.ts,
  }));
}

/** Have two status snapshots diverged on any field the client renders? */
export function statusChanged(
  a: LiveStatusSnapshot | null,
  b: LiveStatusSnapshot | null,
): boolean {
  if (a === null || b === null) return a !== b;
  return (
    a.status !== b.status ||
    a.spend_usd !== b.spend_usd ||
    a.budget_usd !== b.budget_usd ||
    a.deadline !== b.deadline ||
    a.ended_at !== b.ended_at
  );
}
