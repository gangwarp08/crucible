import type { Sandbox } from "e2b";

export interface SessionEntry {
  sandbox: Sandbox;
  sandboxId: string;
  createdAt: Date;
}

// In-memory session store keyed by sessionId.
// TODO: persist session to Supabase (Week 1.3)
export const sessionRegistry = new Map<string, SessionEntry>();
