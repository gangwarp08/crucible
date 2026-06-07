import type { Sandbox } from "e2b";

export interface PtySocket {
  readyState: number;
  close(code?: number, data?: string): void;
}

export interface SessionEntry {
  sandbox: Sandbox;
  sandboxId: string;
  createdAt: Date;
  deadline: Date;
  litellmKey: string;   // per-session minted key — server-only, never sent to browser
  spendTally: number;   // server-side USD accumulator (layer 2 stop)
  status: "active" | "completed";
  expiryTimer: ReturnType<typeof setTimeout>;
  ptySockets: Set<PtySocket>;
}

// In-memory session store keyed by sessionId.
// Entries are never deleted — completed sessions remain with status='completed'
// so route guards can reject new requests cleanly.
// TODO: persist to Supabase + add TTL-based eviction (later slice)
export const sessionRegistry = new Map<string, SessionEntry>();
