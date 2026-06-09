"use client";
import { useEffect, useState } from "react";
import { getSession } from "@/lib/api";
import { useSessionStore } from "@/stores/sessionStore";

// Always-visible top bar showing the candidate's five scenario-mechanic
// resources. Time and tokens and compute are LIVE (token + compute deductions
// flow through chat / query response shapes; PTY-driven compute deductions
// get picked up by the 3s poll). Money and memory are static context for the
// MVP — hard enforcement is a future slice.

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

interface IndicatorProps {
  label: string;
  value: string;
  denominator?: string | undefined;
  color?: string | undefined;
  context?: boolean | undefined;
}

function Indicator({ label, value, denominator, color, context }: IndicatorProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1, minWidth: 0 }}>
      <div
        style={{
          fontSize: 9,
          color: "#858585",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          marginBottom: 2,
        }}
      >
        {label}
        {context && (
          <span style={{ marginLeft: 5, color: "#555", fontStyle: "italic", letterSpacing: 0, textTransform: "none" }}>
            (context)
          </span>
        )}
      </div>
      <div
        style={{
          fontSize: 13,
          fontFamily: "'SF Mono', Menlo, Consolas, monospace",
          fontVariantNumeric: "tabular-nums",
          color: color ?? "#cccccc",
        }}
      >
        {value}
        {denominator && (
          <span style={{ fontSize: 10, color: "#555", marginLeft: 4 }}>/ {denominator}</span>
        )}
      </div>
    </div>
  );
}

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

  // Catch-all poll for balances that aren't echoed by chat/query responses
  // (PTY-driven compute deductions, mainly). Stops when session ends.
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
        .catch(() => { /* transient — try again next tick */ });
    };
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [sessionId, status, setTokensRemaining, setComputeMinutesRemaining]);

  const timeColor =
    remainingSec < 120 ? "#f48771" : remainingSec < 300 ? "#dcb67a" : "#cccccc";

  const tokensColor =
    tokensRemaining === null
      ? "#858585"
      : tokensRemaining <= 0
        ? "#f48771"
        : tokensRemaining < 20_000
          ? "#dcb67a"
          : "#cccccc";

  const computeColor =
    computeMinutesRemaining === null
      ? "#858585"
      : computeMinutesRemaining <= 0
        ? "#f48771"
        : computeMinutesRemaining < 10
          ? "#dcb67a"
          : "#cccccc";

  // Static context — values come from scenarioConstraints (the frozen
  // snapshot stashed at session creation).
  const moneyUsd = scenarioConstraints?.money_usd;
  const memoryMb = scenarioConstraints?.memory_mb;
  const tokenBudget = scenarioConstraints?.tokens;
  const computeBudget = scenarioConstraints?.compute_minutes;
  const timeBudget = scenarioConstraints?.time_minutes;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 28,
        padding: "6px 16px",
        background: "#2d2d2d",
        borderBottom: "1px solid #404040",
        flexShrink: 0,
        userSelect: "none",
      }}
    >
      <Indicator
        label="Time"
        value={status === "active" ? fmtTime(remainingSec) : status === "ended" ? "ENDED" : "OFF"}
        denominator={timeBudget ? `${timeBudget}m` : undefined}
        color={status === "active" ? timeColor : "#f48771"}
      />
      <Indicator
        label="Tokens"
        value={tokensRemaining !== null ? Math.max(0, tokensRemaining).toLocaleString("en-US") : "—"}
        denominator={tokenBudget ? tokenBudget.toLocaleString("en-US") : undefined}
        color={tokensColor}
      />
      <Indicator
        label="Compute"
        value={
          computeMinutesRemaining !== null
            ? `${Math.max(0, computeMinutesRemaining).toFixed(2)}m`
            : "—"
        }
        denominator={computeBudget ? `${computeBudget}m` : undefined}
        color={computeColor}
      />
      <Indicator
        label="Money"
        value={moneyUsd !== null && moneyUsd !== undefined ? `$${moneyUsd}` : "—"}
        context
      />
      <Indicator
        label="Memory"
        value={memoryMb !== null && memoryMb !== undefined ? `${memoryMb.toLocaleString("en-US")} MB` : "—"}
        context
      />
      <div style={{ flex: 1 }} />
      {status === "token_exhausted" && (
        <div style={{ fontSize: 11, color: "#f48771", fontWeight: 500 }}>
          AI assistant locked
        </div>
      )}
      {status === "budget_exhausted" && (
        <div style={{ fontSize: 11, color: "#f48771", fontWeight: 500 }}>
          Platform budget exhausted — session closed
        </div>
      )}
    </div>
  );
}
