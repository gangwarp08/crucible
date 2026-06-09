"use client";
import { create } from "zustand";
import type { ScenarioConstraints } from "@/lib/api";

export interface Message {
  role: "user" | "assistant";
  text: string;
}

export type SessionStatus =
  | "active"
  | "budget_exhausted"      // USD platform budget hit; session over
  | "token_exhausted"       // scenario AI token budget hit; session continues but assistant disabled
  | "ended";

export interface ScenarioPresentation {
  title:      string | null;
  brief:      string | null;
  role:       string | null;
  difficulty: string | null;
}

interface SessionState {
  sessionId: string | null;
  deadline: string | null;   // ISO string
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
  ) => void;
  addMessage: (msg: Message) => void;
  setSpendBudget: (spend: number, budget: number) => void;
  setTokensRemaining: (tokensRemaining: number | null) => void;
  setComputeMinutesRemaining: (computeMinutesRemaining: number | null) => void;
  setStatus: (status: SessionStatus) => void;
}

const EMPTY_SCENARIO: ScenarioPresentation = {
  title: null, brief: null, role: null, difficulty: null,
};

export const useSessionStore = create<SessionState>((set) => ({
  sessionId: null,
  deadline: null,
  endedAt: null,
  messages: [],
  spend: 0,
  budget: 0,
  tokensRemaining: null,
  computeMinutesRemaining: null,
  scenarioConstraints: null,
  scenario: EMPTY_SCENARIO,
  status: "active",

  init: (sessionId, deadline, budget, spend, tokensRemaining, computeMinutesRemaining, scenarioConstraints, scenario) =>
    set({
      sessionId,
      deadline,
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

  addMessage: (msg) =>
    set((s) => ({ messages: [...s.messages, msg] })),

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
      if (status === "ended" && s.status !== "ended") {
        return { status, endedAt: new Date().toISOString() };
      }
      return { status };
    }),
}));
