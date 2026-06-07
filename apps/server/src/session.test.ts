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
  finalizeSession: vi.fn().mockResolvedValue(undefined),
}));

// --- Imports (after mocks) --------------------------------------------------

import { Sandbox } from "e2b";
import { revokeSessionKey } from "./services/litellm.js";
import { finalizeSession } from "./services/db.js";
import { createSandbox } from "./services/sandbox.js";
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
