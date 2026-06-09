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

interface SessionState {
  sessionId: string | null;
  deadline: string | null;   // ISO string
  messages: Message[];
  spend: number;
  budget: number;
  tokensRemaining: number | null;          // live scenario AI token balance
  computeMinutesRemaining: number | null;  // live scenario compute-minutes balance
  scenarioConstraints: ScenarioConstraints | null;  // frozen denominators for "X / Y" HUD displays
  status: SessionStatus;

  init: (
    sessionId: string,
    deadline: string,
    budget: number,
    spend: number,
    tokensRemaining: number | null,
    computeMinutesRemaining: number | null,
    scenarioConstraints: ScenarioConstraints | null,
  ) => void;
  addMessage: (msg: Message) => void;
  setSpendBudget: (spend: number, budget: number) => void;
  setTokensRemaining: (tokensRemaining: number | null) => void;
  setComputeMinutesRemaining: (computeMinutesRemaining: number | null) => void;
  setStatus: (status: SessionStatus) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessionId: null,
  deadline: null,
  messages: [],
  spend: 0,
  budget: 0,
  tokensRemaining: null,
  computeMinutesRemaining: null,
  scenarioConstraints: null,
  status: "active",

  init: (sessionId, deadline, budget, spend, tokensRemaining, computeMinutesRemaining, scenarioConstraints) =>
    set({
      sessionId,
      deadline,
      budget,
      spend,
      tokensRemaining,
      computeMinutesRemaining,
      scenarioConstraints,
      status: "active",
      messages: [],
    }),

  addMessage: (msg) =>
    set((s) => ({ messages: [...s.messages, msg] })),

  setSpendBudget: (spend, budget) => set({ spend, budget }),

  setTokensRemaining: (tokensRemaining) => set({ tokensRemaining }),

  setComputeMinutesRemaining: (computeMinutesRemaining) =>
    set({ computeMinutesRemaining }),

  setStatus: (status) => set({ status }),
}));
