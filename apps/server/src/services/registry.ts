import type { Sandbox } from "e2b";

export interface PtySocket {
  readyState: number;
  close(code?: number, data?: string): void;
}

/** Reuse the same minimal socket shape for the messaging WS — close+readyState
 *  are all expireSession needs to flush the connection on teardown. */
export type MessagingSocket = PtySocket;

/** One turn in a persona channel — kept in memory only (events table is the
 *  durable log). Used to seed the messages array on the next LLM call. */
export interface PersonaTurn {
  role: "candidate" | "persona";
  text: string;
  ts: string; // ISO 8601
}

/** Per-channel beat-tracking flags. Mirrored into scenarioState.personas so
 *  recruiter review + future analysis can see when each reveal fired. */
export interface PersonaState {
  client: { revealed_specifics: boolean };
  team:   { gave_refund_hint: boolean; gave_webhook_clue: boolean };
}

/** A single buffered telemetry event waiting to be flushed to Supabase. */
export interface EventRecord {
  id: string;
  session_id: string;
  seq: number;
  type: string;
  actor: string;
  ts: string; // ISO 8601
  payload: Record<string, unknown>;
}

export interface SessionEntry {
  sandbox: Sandbox;
  sandboxId: string;
  createdAt: Date;
  deadline: Date;
  litellmKey: string;      // per-session minted key — server-only, never sent to browser
  spendTally: number;      // server-side USD accumulator (layer 2 stop)
  status: "active" | "completed";
  expiryTimer: ReturnType<typeof setTimeout>;
  ptySockets: Set<PtySocket>;

  // Telemetry — events table
  nextSeq: number;                               // monotonic seq across ALL event types
  eventBuffer: EventRecord[];                    // events pending flush to Supabase
  flushTimer: ReturnType<typeof setTimeout> | null;

  // Telemetry — PTY stream batching
  ptyOutputBuffer: Buffer[];                     // sandbox→browser bytes pending flush
  ptyInputBuffer: Buffer[];                      // browser→sandbox bytes pending flush
  ptyOutputFlushTimer: ReturnType<typeof setTimeout> | null;
  ptyInputFlushTimer: ReturnType<typeof setTimeout> | null;

  // Telemetry — file snapshot dedup
  lastFileHashes: Map<string, string>;           // path → sha256 of last written content

  // Telemetry — transcript
  systemPromptWritten: boolean;                  // only one system row per session
  nextTranscriptSeq: number;                     // monotonic seq within transcript table

  // FDE simulation — null when this session isn't tied to a scenario.
  // scenarioState is the live game-mechanic ledger; initialized from the
  // scenario's constraints at session start and mutated as the simulation runs.
  scenarioId: string | null;
  scenarioState: Record<string, unknown>;

  // Persona messaging (client / team channels).
  messagingSockets: Set<MessagingSocket>;
  channelHistory: { client: PersonaTurn[]; team: PersonaTurn[] };
  personaState: PersonaState;
}

// In-memory session store keyed by sessionId.
// Entries are never deleted — completed sessions remain with status='completed'.
// TODO: add TTL-based eviction for old completed entries (later slice)
export const sessionRegistry = new Map<string, SessionEntry>();
