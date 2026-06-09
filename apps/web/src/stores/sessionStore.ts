"use client";
import { create } from "zustand";

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
  tokensRemaining: number | null;   // scenario AI token balance; null when no scenario
  status: SessionStatus;

  init: (
    sessionId: string,
    deadline: string,
    budget: number,
    spend: number,
    tokensRemaining: number | null,
  ) => void;
  addMessage: (msg: Message) => void;
  setSpendBudget: (spend: number, budget: number) => void;
  setTokensRemaining: (tokensRemaining: number | null) => void;
  setStatus: (status: SessionStatus) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessionId: null,
  deadline: null,
  messages: [],
  spend: 0,
  budget: 0,
  tokensRemaining: null,
  status: "active",

  init: (sessionId, deadline, budget, spend, tokensRemaining) =>
    set({
      sessionId,
      deadline,
      budget,
      spend,
      tokensRemaining,
      status: "active",
      messages: [],
    }),

  addMessage: (msg) =>
    set((s) => ({ messages: [...s.messages, msg] })),

  setSpendBudget: (spend, budget) => set({ spend, budget }),

  setTokensRemaining: (tokensRemaining) => set({ tokensRemaining }),

  setStatus: (status) => set({ status }),
}));
