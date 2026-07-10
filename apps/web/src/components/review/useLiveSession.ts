"use client";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  openSessionLiveStream,
  type LiveEvent,
  type LiveStatus,
  type LiveStreamHandle,
  type ReviewEvent,
} from "@/lib/api";

// Read-only live-session hook. Opens the SSE feed for a running session, merges
// incoming event rows into a growing, seq-deduped list the panels can consume,
// and tracks the latest status snapshot for the live strip. On the terminal
// "end" frame it flips `ended` so the host can refetch the full completed view.
//
// Reconnect-from-last-seq: a transient onError re-opens the stream starting at
// the highest seq already seen, so no rows are missed or duplicated. Cleans up
// the stream on unmount / when live mode is turned off.

/** LiveEvent rows are shaped like ReviewEvent minus id/session_id — panels
 *  (Timeline, TerminalReplay, persona/SQL) read type/seq/actor/payload/ts, so we
 *  synthesize the two missing fields when adapting to ReviewEvent. */
function toReviewEvent(sessionId: string, e: LiveEvent): ReviewEvent {
  return {
    id: `live-${e.seq}`,
    session_id: sessionId,
    seq: e.seq,
    type: e.type,
    actor: e.actor,
    ts: e.created_at,
    payload: e.payload,
  };
}

interface MergeState {
  events: ReviewEvent[];
  seen: Set<number>;
  maxSeq: number;
}

type MergeAction =
  | { kind: "seed"; events: ReviewEvent[] }
  | { kind: "append"; sessionId: string; rows: LiveEvent[] };

function mergeReducer(state: MergeState, action: MergeAction): MergeState {
  if (action.kind === "seed") {
    const seen = new Set<number>();
    let maxSeq = 0;
    for (const e of action.events) {
      seen.add(e.seq);
      if (e.seq > maxSeq) maxSeq = e.seq;
    }
    return { events: action.events, seen, maxSeq };
  }
  // append — skip seqs already present (reconnect overlap), keep seq order.
  // A fresh Set/array is returned only when something new lands, so identity
  // stays stable (no needless re-render) on an all-duplicate batch.
  const added: ReviewEvent[] = [];
  let maxSeq = state.maxSeq;
  for (const r of action.rows) {
    if (state.seen.has(r.seq)) continue;
    added.push(toReviewEvent(action.sessionId, r));
    if (r.seq > maxSeq) maxSeq = r.seq;
  }
  if (added.length === 0) return state;
  const seen = new Set(state.seen);
  for (const e of added) seen.add(e.seq);
  const events = [...state.events, ...added].sort((x, y) => x.seq - y.seq);
  return { events, seen, maxSeq };
}

export interface UseLiveSession {
  active: boolean;
  status: LiveStatus | null;
  /** Seed events (from the loaded detail) + everything streamed since, deduped
   *  by seq and seq-ordered. */
  events: ReviewEvent[];
  /** Transient connection state for the strip. */
  connection: "connecting" | "open" | "reconnecting";
  start: () => void;
  stop: () => void;
  /** True once the server sent the terminal "end" frame; host should refetch. */
  ended: boolean;
}

export function useLiveSession(
  sessionId: string,
  seedEvents: ReviewEvent[],
  initialStatus: LiveStatus,
): UseLiveSession {
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [connection, setConnection] = useState<"connecting" | "open" | "reconnecting">("connecting");
  const [ended, setEnded] = useState(false);
  const [merge, dispatch] = useReducer(mergeReducer, undefined, () => ({
    events: seedEvents,
    seen: new Set(seedEvents.map((e) => e.seq)),
    maxSeq: seedEvents.reduce((m, e) => Math.max(m, e.seq), 0),
  }));

  const handleRef = useRef<LiveStreamHandle | null>(null);
  const maxSeqRef = useRef(merge.maxSeq);
  maxSeqRef.current = merge.maxSeq;
  const activeRef = useRef(active);
  activeRef.current = active;

  // (Re)connect from the highest seq we've delivered so far.
  const connect = useCallback(() => {
    handleRef.current?.close();
    handleRef.current = openSessionLiveStream(sessionId, maxSeqRef.current, {
      onStatus: (s) => {
        setConnection("open");
        setStatus(s);
      },
      onEvents: (rows) => dispatch({ kind: "append", sessionId, rows }),
      onEnd: () => {
        setEnded(true);
      },
      onError: () => {
        // Transient drop — reconnect from last seq after a short backoff, but
        // only while still in live mode.
        if (!activeRef.current) return;
        setConnection("reconnecting");
        window.setTimeout(() => {
          if (activeRef.current) connect();
        }, 1500);
      },
      onUnsupported: () => {
        // Older server without the route — leave live mode silently.
        setActive(false);
      },
    });
  }, [sessionId]);

  const start = useCallback(() => {
    setEnded(false);
    setStatus(initialStatus);
    setConnection("connecting");
    setActive(true);
  }, [initialStatus]);

  const stop = useCallback(() => {
    setActive(false);
    handleRef.current?.close();
    handleRef.current = null;
  }, []);

  // Open the stream when live mode turns on; tear down on off / unmount.
  useEffect(() => {
    if (!active) return;
    connect();
    return () => {
      handleRef.current?.close();
      handleRef.current = null;
    };
  }, [active, connect]);

  // Re-seed the merge buffer whenever a fresh detail load provides new seeds
  // (e.g. after the post-end refetch) — but only while NOT actively streaming,
  // so we never clobber live rows mid-session.
  useEffect(() => {
    if (active) return;
    dispatch({ kind: "seed", events: seedEvents });
  }, [seedEvents, active]);

  return {
    active,
    status,
    events: merge.events,
    connection,
    start,
    stop,
    ended,
  };
}
