"use client";
import { create } from "zustand";
import type { ScenarioConstraints } from "@/lib/api";

export interface Message {
  role: "user" | "assistant";
  text: string;
}

export type SessionStatus =
  | "active"
  | "locked"                // RD1: deliverable submitted / defending — workspace read-only
  | "budget_exhausted"      // USD platform budget hit; session over
  | "token_exhausted"       // scenario AI token budget hit; session continues but assistant disabled
  | "ended";

/** Workspace mutations (edit/terminal/AI/query/deliverable) are only allowed
 *  while truly active. locked/ended/exhausted are read-only. */
export function isWorkspaceWritable(status: SessionStatus): boolean {
  return status === "active";
}

export interface ScenarioPresentation {
  title:      string | null;
  brief:      string | null;
  role:       string | null;
  difficulty: string | null;
  // Client/team persona name+role for the MESSAGES panel channel header.
  // Null on older sessions → Messages falls back to legacy hardcoded labels.
  clientPersona: { name: string; role: string } | null;
  teamPersona:   { name: string; role: string } | null;
}

interface SessionState {
  sessionId: string | null;
  deadline: string | null;   // ISO string
  // Deferred session clock: false until the candidate presses "Start working".
  // While false the HUD shows a "Ready — press Start" state; once true the
  // countdown runs against `deadline`. Reset to false on init for a new session.
  clockStarted: boolean;
  endedAt: string | null;    // ISO string — set when status flips to "ended"
  messages: Message[];
  spend: number;
  budget: number;
  tokensRemaining: number | null;          // live scenario AI token balance
  computeMinutesRemaining: number | null;  // live scenario compute-minutes balance
  scenarioConstraints: ScenarioConstraints | null;  // frozen denominators for "X / Y" HUD displays
  scenario: ScenarioPresentation;                   // candidate-facing scenario chrome
  status: SessionStatus;

  init: (
    sessionId: string,
    deadline: string,
    budget: number,
    spend: number,
    tokensRemaining: number | null,
    computeMinutesRemaining: number | null,
    scenarioConstraints: ScenarioConstraints | null,
    scenario: ScenarioPresentation,
    clockStarted: boolean,
  ) => void;
  /** Mark the deferred clock started and set the fresh work deadline. Called
   *  after POST /sessions/:id/start returns. */
  startClock: (deadline: string) => void;
  addMessage: (msg: Message) => void;
  /** Bulk replace the AI assistant message log. Used by Workspace's mount
   *  effect to hydrate the pane from the transcript table on refresh.
   *  Distinct from addMessage so a stray hydrate after a fresh turn can't
   *  duplicate. */
  setMessages: (messages: Message[]) => void;
  setSpendBudget: (spend: number, budget: number) => void;
  setTokensRemaining: (tokensRemaining: number | null) => void;
  setComputeMinutesRemaining: (computeMinutesRemaining: number | null) => void;
  setStatus: (status: SessionStatus) => void;
}

const EMPTY_SCENARIO: ScenarioPresentation = {
  title: null, brief: null, role: null, difficulty: null,
  clientPersona: null, teamPersona: null,
};

export const useSessionStore = create<SessionState>((set) => ({
  sessionId: null,
  deadline: null,
  clockStarted: false,
  endedAt: null,
  messages: [],
  spend: 0,
  budget: 0,
  tokensRemaining: null,
  computeMinutesRemaining: null,
  scenarioConstraints: null,
  scenario: EMPTY_SCENARIO,
  status: "active",

  init: (sessionId, deadline, budget, spend, tokensRemaining, computeMinutesRemaining, scenarioConstraints, scenario, clockStarted) =>
    set({
      sessionId,
      deadline,
      clockStarted,
      endedAt: null,
      budget,
      spend,
      tokensRemaining,
      computeMinutesRemaining,
      scenarioConstraints,
      scenario,
      status: "active",
      messages: [],
    }),

  startClock: (deadline) => set({ deadline, clockStarted: true }),

  addMessage: (msg) =>
    set((s) => ({ messages: [...s.messages, msg] })),

  setMessages: (messages) => set({ messages }),

  setSpendBudget: (spend, budget) => set({ spend, budget }),

  setTokensRemaining: (tokensRemaining) => set({ tokensRemaining }),

  setComputeMinutesRemaining: (computeMinutesRemaining) =>
    set({ computeMinutesRemaining }),

  // Stamp endedAt on the FIRST flip to "ended" so the EndScreen shows the
  // moment the session actually ended (not the moment EndScreen rendered).
  // Re-flipping (e.g. via hydration on a reload after expiry) preserves the
  // first stamp.
  setStatus: (status) =>
    set((s) => {
      // "ended" is terminal on the client — once ended (e.g. after submit),
      // never downgrade back to active/locked from a late poll or event.
      // init() resets a fresh session independently of this setter.
      if (s.status === "ended") return {};
      if (status === "ended") {
        return { status, endedAt: new Date().toISOString() };
      }
      return { status };
    }),
}));
