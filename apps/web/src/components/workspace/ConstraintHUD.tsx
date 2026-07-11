"use client";
import { useEffect, useRef, useState } from "react";
import { getSession } from "@/lib/api";
import { useSessionStore } from "@/stores/sessionStore";
import { color } from "@/styles/tokens";
import Stat from "@/components/ui/Stat";

// Horizontal live-resource readout designed to slot into the workspace's
// merged top chrome row. Renders five Stat cells (Time / Tokens / Compute /
// Money / Memory) plus a status badge when the AI assistant or platform
// budget is exhausted. No wrapper background — the parent chrome row owns
// padding and background.

const POLL_INTERVAL_MS = 3_000;

function useCountdown(deadline: string | null, onExpire: () => void): number {
  const [remaining, setRemaining] = useState(0);
  // Latest-ref pattern: keeps the interval stable across renders while the
  // tick always sees the caller's freshest onExpire closure.
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  useEffect(() => {
    if (!deadline) return;
    const deadlineMs = new Date(deadline).getTime();
    const tick = () => {
      const secs = Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000));
      setRemaining(secs);
      if (secs === 0) onExpireRef.current();
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadline]);
  return remaining;
}

function fmtTime(seconds: number): string {
  const m = String(Math.floor(seconds / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

type Tone = "default" | "warn" | "error" | "muted";

export default function ConstraintHUD() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const deadline = useSessionStore((s) => s.deadline);
  const clockStarted = useSessionStore((s) => s.clockStarted);
  const tokensRemaining = useSessionStore((s) => s.tokensRemaining);
  const computeMinutesRemaining = useSessionStore((s) => s.computeMinutesRemaining);
  const scenarioConstraints = useSessionStore((s) => s.scenarioConstraints);
  const status = useSessionStore((s) => s.status);
  const setStatus = useSessionStore((s) => s.setStatus);
  const setTokensRemaining = useSessionStore((s) => s.setTokensRemaining);
  const setComputeMinutesRemaining = useSessionStore((s) => s.setComputeMinutesRemaining);

  // Deferred clock: before the candidate starts the simulation the deadline is
  // the creation-relative SAFETY ceiling, not the work deadline — so we must NOT
  // count down against it. Passing null freezes the countdown; the Time cell
  // shows the full scenario time as a static "ready" value below.
  const remainingSec = useCountdown(clockStarted ? deadline : null, () => {
    if (status === "active") setStatus("ended");
  });

  useEffect(() => {
    if (!sessionId || status !== "active") return;
    const tick = () => {
      void getSession(sessionId)
        .then((s) => {
          if (s.scenarioBalances) {
            setTokensRemaining(s.scenarioBalances.tokens);
            setComputeMinutesRemaining(s.scenarioBalances.compute_minutes);
          }
        })
        .catch(() => { /* transient */ });
    };
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [sessionId, status, setTokensRemaining, setComputeMinutesRemaining]);

  const timeTone: Tone =
    !clockStarted ? "muted"
    : status !== "active" ? "error"
    : remainingSec < 120 ? "error"
    : remainingSec < 300 ? "warn"
    : "default";

  const tokensTone: Tone =
    tokensRemaining === null ? "muted"
    : tokensRemaining <= 0 ? "error"
    : tokensRemaining < 20_000 ? "warn"
    : "default";

  const computeTone: Tone =
    computeMinutesRemaining === null ? "muted"
    : computeMinutesRemaining <= 0 ? "error"
    : computeMinutesRemaining < 10 ? "warn"
    : "default";

  const moneyUsd       = scenarioConstraints?.money_usd;
  const memoryMb       = scenarioConstraints?.memory_mb;
  const tokenBudget    = scenarioConstraints?.tokens;
  const computeBudget  = scenarioConstraints?.compute_minutes;
  const timeBudget     = scenarioConstraints?.time_minutes;

  const timeValue =
    // Pre-start: the clock hasn't begun — show the full scenario time as a
    // static "ready" figure (never a live countdown / 00:00) so the candidate
    // sees what they'll get, not a ticking or zeroed clock.
    !clockStarted ? (timeBudget ? fmtTime(timeBudget * 60) : "—")
    : status === "active" ? fmtTime(remainingSec)
    : status === "ended" ? "ENDED"
    : "OFF";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20, minWidth: 0 }}>
      <Stat
        label="Time"
        value={timeValue}
        denominator={timeBudget ? `/ ${timeBudget}m` : undefined}
        tone={timeTone}
        size="sm"
      />
      <Stat
        label="Tokens"
        value={tokensRemaining !== null ? Math.max(0, tokensRemaining).toLocaleString("en-US") : "—"}
        denominator={tokenBudget ? `/ ${tokenBudget.toLocaleString("en-US")}` : undefined}
        tone={tokensTone}
        size="sm"
      />
      <Stat
        label="Compute"
        value={computeMinutesRemaining !== null ? `${Math.max(0, computeMinutesRemaining).toFixed(2)}m` : "—"}
        denominator={computeBudget ? `/ ${computeBudget}m` : undefined}
        tone={computeTone}
        size="sm"
      />
      <Stat
        label="Money"
        value={moneyUsd !== null && moneyUsd !== undefined ? `$${moneyUsd}` : "—"}
        tone="muted"
        size="sm"
      />
      <Stat
        label="Memory"
        value={memoryMb !== null && memoryMb !== undefined ? `${memoryMb.toLocaleString("en-US")}MB` : "—"}
        tone="muted"
        size="sm"
      />
      {status === "token_exhausted" && (
        <span style={{ fontSize: 11, color: color.error.base, fontWeight: 500, marginLeft: 8 }}>
          AI assistant locked
        </span>
      )}
      {status === "budget_exhausted" && (
        <span style={{ fontSize: 11, color: color.error.base, fontWeight: 500, marginLeft: 8 }}>
          Platform budget exhausted
        </span>
      )}
    </div>
  );
}
