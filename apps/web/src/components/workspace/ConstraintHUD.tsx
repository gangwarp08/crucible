"use client";
import { useEffect, useState } from "react";
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
  useEffect(() => {
    if (!deadline) return;
    const tick = () => {
      const secs = Math.max(0, Math.floor((new Date(deadline).getTime() - Date.now()) / 1000));
      setRemaining(secs);
      if (secs === 0) onExpire();
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadline, onExpire]);
  return remaining;
}

function fmtTime(seconds: number): string {
  const m = String(Math.floor(seconds / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

type Tone = "default" | "warn" | "error" | "muted";

export default function ConstraintHUD() {
  const {
    sessionId,
    deadline,
    tokensRemaining,
    computeMinutesRemaining,
    scenarioConstraints,
    status,
    setStatus,
    setTokensRemaining,
    setComputeMinutesRemaining,
  } = useSessionStore();

  const remainingSec = useCountdown(deadline, () => {
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
    status !== "active" ? "error" : remainingSec < 120 ? "error" : remainingSec < 300 ? "warn" : "default";

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
    status === "active" ? fmtTime(remainingSec)
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
