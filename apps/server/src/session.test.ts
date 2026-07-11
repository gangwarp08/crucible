import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// --- Mocks (hoisted before all imports) ------------------------------------

vi.mock("../src/env.js", () => ({
  env: {
    NODE_ENV: "test",
    PORT: 3001,
    HOST: "0.0.0.0",
    E2B_API_KEY: "test-e2b-key",
    LITELLM_BASE_URL: "http://localhost:4000",
    LITELLM_MASTER_KEY: "sk-master-test",
    SESSION_BUDGET_USD: 2.0,
    SESSION_TIMEOUT_MIN: 1, // 1 minute — fast enough to advance in tests
  },
}));

vi.mock("e2b", () => ({
  Sandbox: { create: vi.fn() },
}));

vi.mock("./services/litellm.js", () => ({
  mintSessionKey: vi.fn().mockResolvedValue("sk-session-test"),
  revokeSessionKey: vi.fn().mockResolvedValue(undefined),
}));

// Stub out Supabase and db so tests never hit real infra.
vi.mock("./services/supabase.js", () => ({ supabase: null }));
vi.mock("./services/db.js", () => ({
  persistSessionCreated: vi.fn().mockResolvedValue(undefined),
  persistSessionUpdate: vi.fn().mockResolvedValue(undefined),
  persistScenarioStatePatch: vi.fn().mockResolvedValue(undefined),
  finalizeSession: vi.fn().mockResolvedValue(undefined),
  loadSessionRow: vi.fn().mockResolvedValue(null),
}));

// --- Imports (after mocks) --------------------------------------------------

import { Sandbox } from "e2b";
import { revokeSessionKey } from "./services/litellm.js";
import { finalizeSession } from "./services/db.js";
import { createSandbox, startSessionClock } from "./services/sandbox.js";
import { sessionRegistry } from "./services/registry.js";
import { expireSession } from "./services/session.js";

// ---------------------------------------------------------------------------

describe("Session orchestrator kill-switch", () => {
  let mockSandbox: {
    sandboxId: string;
    kill: ReturnType<typeof vi.fn>;
    pty: { create: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; sendInput: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sessionRegistry.clear();

    mockSandbox = {
      sandboxId: "test-sandbox-id",
      kill: vi.fn().mockResolvedValue(undefined),
      pty: {
        create: vi.fn(),
        kill: vi.fn().mockResolvedValue(undefined),
        sendInput: vi.fn(),
      },
    };
    vi.mocked(Sandbox.create).mockResolvedValue(mockSandbox as never);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    sessionRegistry.clear();
  });

  it("expireSession closes PTY sockets, kills sandbox, revokes key, sets status=completed", async () => {
    const sessionId = "test-session-expire";
    await createSandbox(sessionId);

    const entry = sessionRegistry.get(sessionId)!;
    expect(entry).toBeDefined();
    expect(entry.status).toBe("active");

    const mockSocket = { readyState: 1, close: vi.fn() };
    entry.ptySockets.add(mockSocket);

    await expireSession(sessionId, "manual");

    expect(mockSandbox.kill).toHaveBeenCalledOnce();
    expect(revokeSessionKey).toHaveBeenCalledWith("sk-session-test");
    expect(mockSocket.close).toHaveBeenCalledWith(1001, "Session expired");
    expect(entry.status).toBe("completed");
    expect(entry.ptySockets.size).toBe(0);
    // Supabase finalization called with correct end reason
    expect(finalizeSession).toHaveBeenCalledWith(sessionId, "manual");
  });

  it("expireSession is idempotent — second call is a no-op", async () => {
    const sessionId = "test-session-idempotent";
    await createSandbox(sessionId);

    await expireSession(sessionId, "manual");
    await expireSession(sessionId, "manual"); // second call

    expect(mockSandbox.kill).toHaveBeenCalledOnce();
    expect(revokeSessionKey).toHaveBeenCalledOnce();
    expect(finalizeSession).toHaveBeenCalledOnce();
  });

  it("orchestrator timer fires expireSession(timeout) after SESSION_TIMEOUT_MIN", async () => {
    const sessionId = "test-session-timer";
    await createSandbox(sessionId);

    const entry = sessionRegistry.get(sessionId)!;
    const mockSocket = { readyState: 1, close: vi.fn() };
    entry.ptySockets.add(mockSocket);

    expect(entry.status).toBe("active");

    await vi.advanceTimersByTimeAsync(1 * 60_000);

    expect(entry.status).toBe("completed");
    expect(mockSandbox.kill).toHaveBeenCalledOnce();
    expect(revokeSessionKey).toHaveBeenCalledWith("sk-session-test");
    expect(mockSocket.close).toHaveBeenCalled();
    expect(finalizeSession).toHaveBeenCalledWith(sessionId, "timeout");
  });

  it("deadline is set to createdAt + SESSION_TIMEOUT_MIN", async () => {
    const before = Date.now();
    const sessionId = "test-session-deadline";
    await createSandbox(sessionId);

    const entry = sessionRegistry.get(sessionId)!;
    const deadlineMs = entry.deadline.getTime();
    const expectedMs = before + 1 * 60_000;

    expect(deadlineMs).toBeGreaterThanOrEqual(expectedMs - 100);
    expect(deadlineMs).toBeLessThanOrEqual(expectedMs + 100);
  });

  it("new session entry has telemetry fields initialised", async () => {
    const sessionId = "test-session-telemetry-init";
    await createSandbox(sessionId);

    const entry = sessionRegistry.get(sessionId)!;
    expect(entry.nextSeq).toBeGreaterThan(0); // session.created event bumped it
    expect(entry.eventBuffer.length).toBeGreaterThanOrEqual(0); // may have been flushed
    expect(entry.status).toBe("active");
  });
});

describe("Deferred session clock (orientation overlay)", () => {
  let mockSandbox: { sandboxId: string; kill: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sessionRegistry.clear();
    mockSandbox = { sandboxId: "test-sandbox-id", kill: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(Sandbox.create).mockResolvedValue(mockSandbox as never);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    sessionRegistry.clear();
  });

  it("a freshly created session is NOT clock-started (clock_started_at unset)", async () => {
    // A scenario-bound session seeds clock_started_at:null; a legacy no-scenario
    // session has no key at all. Both must read as "not started".
    const sessionId = "deferred-fresh";
    await createSandbox(sessionId);
    const entry = sessionRegistry.get(sessionId)!;
    const csa = entry.scenarioState["clock_started_at"];
    // GET /sessions maps (typeof csa === "string" && len>0) → clockStarted.
    const clockStarted = typeof csa === "string" && csa.length > 0;
    expect(clockStarted).toBe(false);
  });

  it("the countdown does NOT run until /start: the creation deadline is the safety ceiling", async () => {
    // Before /start the deadline equals creation + SESSION_TIMEOUT_MIN. That is
    // the ABSOLUTE cost ceiling, and the kill-switch still fires at it so an
    // abandoned pre-start session is reaped — but the WORK clock has not begun.
    const before = Date.now();
    const sessionId = "deferred-ceiling";
    await createSandbox(sessionId);
    const entry = sessionRegistry.get(sessionId)!;
    const expectedCeiling = before + 1 * 60_000; // SESSION_TIMEOUT_MIN=1 in mock
    expect(entry.deadline.getTime()).toBeGreaterThanOrEqual(expectedCeiling - 100);
    expect(entry.deadline.getTime()).toBeLessThanOrEqual(expectedCeiling + 100);
    // Never started → still active well before the ceiling.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(entry.status).toBe("active");
    // Ceiling reached with no /start → kill-switch reaps it (cost is bounded).
    await vi.advanceTimersByTimeAsync(30_000);
    expect(entry.status).toBe("completed");
  });

  it("startSessionClock arms a FRESH deadline ≈ now + timeout and stamps clock_started_at", async () => {
    const sessionId = "deferred-start";
    await createSandbox(sessionId);
    // Simulate a 20s orientation pause before the candidate begins.
    await vi.advanceTimersByTimeAsync(20_000);

    const at = Date.now();
    const result = await startSessionClock(sessionId);
    expect(result).not.toBeNull();
    const entry = sessionRegistry.get(sessionId)!;

    // Fresh work deadline is now + full SESSION_TIMEOUT_MIN — the candidate gets
    // the WHOLE timeout for work, measured from /start, not from creation.
    expect(Date.parse(result!.deadline)).toBeGreaterThanOrEqual(at + 60_000 - 100);
    expect(Date.parse(result!.deadline)).toBeLessThanOrEqual(at + 60_000 + 100);
    expect(entry.deadline.toISOString()).toBe(result!.deadline);

    const csa = entry.scenarioState["clock_started_at"];
    expect(typeof csa).toBe("string");
    expect(Number.isNaN(Date.parse(csa as string))).toBe(false);
  });

  it("the full SESSION_TIMEOUT_MIN applies from /start (kill-switch re-armed), not from creation", async () => {
    const sessionId = "deferred-rearmed";
    await createSandbox(sessionId);
    await vi.advanceTimersByTimeAsync(20_000); // orientation
    await startSessionClock(sessionId);
    const entry = sessionRegistry.get(sessionId)!;

    // 59s after /start: still active (the creation-relative timer would have
    // fired at 40s-from-now had it NOT been re-armed).
    await vi.advanceTimersByTimeAsync(59_000);
    expect(entry.status).toBe("active");
    // Cross the full timeout from /start → expires.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(entry.status).toBe("completed");
  });

  it("startSessionClock is idempotent — a second call never extends the deadline", async () => {
    const sessionId = "deferred-idem";
    await createSandbox(sessionId);
    const r1 = await startSessionClock(sessionId);
    const csa1 = sessionRegistry.get(sessionId)!.scenarioState["clock_started_at"];
    await vi.advanceTimersByTimeAsync(5_000);
    const r2 = await startSessionClock(sessionId);
    expect(r2!.deadline).toBe(r1!.deadline);
    expect(sessionRegistry.get(sessionId)!.scenarioState["clock_started_at"]).toBe(csa1);
  });

  it("startSessionClock on an unknown session returns null (route → 404)", async () => {
    expect(await startSessionClock("no-such-session")).toBeNull();
  });
});
