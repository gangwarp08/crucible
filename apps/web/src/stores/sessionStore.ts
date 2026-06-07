"use client";
import { create } from "zustand";

export interface Message {
  role: "user" | "assistant";
  text: string;
}

export type SessionStatus = "active" | "budget_exhausted" | "ended";

interface SessionState {
  sessionId: string | null;
  deadline: string | null;   // ISO string
  messages: Message[];
  spend: number;
  budget: number;
  status: SessionStatus;

  init: (sessionId: string, deadline: string, budget: number, spend: number) => void;
  addMessage: (msg: Message) => void;
  setSpendBudget: (spend: number, budget: number) => void;
  setStatus: (status: SessionStatus) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessionId: null,
  deadline: null,
  messages: [],
  spend: 0,
  budget: 0,
  status: "active",

  init: (sessionId, deadline, budget, spend) =>
    set({ sessionId, deadline, budget, spend, status: "active", messages: [] }),

  addMessage: (msg) =>
    set((s) => ({ messages: [...s.messages, msg] })),

  setSpendBudget: (spend, budget) => set({ spend, budget }),

  setStatus: (status) => set({ status }),
}));
