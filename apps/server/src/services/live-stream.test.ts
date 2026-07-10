import { describe, it, expect } from "vitest";

// Pure helpers only — these never touch Supabase, so no infra mock is needed.
// (readLiveStatus / readEventsSince are exercised against real infra by the
// live-monitoring verify script.)
import {
  isTerminalStatus,
  isLiveStatus,
  statusChanged,
  type LiveStatusSnapshot,
} from "./live-stream.js";

describe("live-stream status helpers", () => {
  it("treats any non-running status as terminal (completed/timed_out/errored)", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    // Reaper writes "timed_out"; error states are terminal too — all must end
    // the stream, not just "completed".
    expect(isTerminalStatus("timed_out")).toBe(true);
    expect(isTerminalStatus("errored")).toBe(true);
    expect(isTerminalStatus("active")).toBe(false);
    expect(isTerminalStatus("submitted")).toBe(false);
    expect(isTerminalStatus("defending")).toBe(false);
    // null/undefined = unknown → keep watching (not terminal).
    expect(isTerminalStatus(null)).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
  });

  it("treats active/submitted/defending as live (watchable)", () => {
    expect(isLiveStatus("active")).toBe(true);
    expect(isLiveStatus("submitted")).toBe(true);
    expect(isLiveStatus("defending")).toBe(true);
    expect(isLiveStatus("completed")).toBe(false);
    expect(isLiveStatus(null)).toBe(false);
  });
});

describe("statusChanged", () => {
  const base: LiveStatusSnapshot = {
    status: "active",
    spend_usd: 0.12,
    budget_usd: 1,
    deadline: "2026-07-10T12:00:00.000Z",
    ended_at: null,
  };

  it("is false for an identical snapshot", () => {
    expect(statusChanged(base, { ...base })).toBe(false);
  });

  it("detects a spend change (drives the live status strip)", () => {
    expect(statusChanged(base, { ...base, spend_usd: 0.2 })).toBe(true);
  });

  it("detects status and ended_at transitions", () => {
    expect(statusChanged(base, { ...base, status: "completed" })).toBe(true);
    expect(statusChanged(base, { ...base, ended_at: "2026-07-10T12:00:00Z" })).toBe(true);
  });

  it("handles null snapshots (first emit / row gone)", () => {
    expect(statusChanged(null, base)).toBe(true);
    expect(statusChanged(base, null)).toBe(true);
    expect(statusChanged(null, null)).toBe(false);
  });
});
