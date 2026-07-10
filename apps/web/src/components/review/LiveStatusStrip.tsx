"use client";
import { useEffect, useState } from "react";
import type { LiveStatus } from "@/lib/api";
import { color, font, radius } from "@/styles/tokens";
import { formatSpendPrecise } from "./format";

interface Props {
  status: LiveStatus | null;
  connection: "connecting" | "open" | "reconnecting";
  onStop: () => void;
}

/** ms → "12:34" (or "1:02:03") countdown, clamped at 0. */
function formatCountdown(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Live status strip for a session being watched in real time: a pulsing LIVE
 *  badge, current status, spend/budget, and a ticking countdown to the deadline.
 *  Read-only — the only control is "Stop watching". */
export default function LiveStatusStrip({ status, connection, onStop }: Props) {
  // Local clock tick so the countdown updates every second between status
  // frames (which only arrive on change).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const deadlineMs = status?.deadline ? Date.parse(status.deadline) : NaN;
  const remaining = Number.isNaN(deadlineMs) ? null : deadlineMs - now;

  const spend = status?.spend_usd ?? 0;
  const budget = status?.budget_usd ?? 0;
  const overBudget = budget > 0 && spend >= budget;

  const connLabel =
    connection === "open" ? "live" : connection === "reconnecting" ? "reconnecting…" : "connecting…";
  const dotColor = connection === "open" ? color.error.base : color.warn.base;

  return (
    <section
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
        background: color.bg.elevated,
        border: `1px solid ${color.border.default}`,
        borderRadius: radius.md,
        padding: "10px 16px",
        marginBottom: 16,
      }}
    >
      <style>{`@keyframes livePulse{0%,100%{opacity:1}50%{opacity:0.35}}`}</style>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: dotColor,
            animation: connection === "open" ? "livePulse 1.4s ease-in-out infinite" : "none",
          }}
        />
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: dotColor,
          }}
        >
          {connLabel}
        </span>
      </span>

      <StripStat label="Status" value={status?.status ?? "—"} />
      <StripStat
        label="Spend"
        value={`${formatSpendPrecise(spend)} / ${formatSpendPrecise(budget)}`}
        tone={overBudget ? color.error.base : undefined}
      />
      <StripStat
        label="Time left"
        value={remaining === null ? "—" : formatCountdown(remaining)}
        tone={remaining !== null && remaining <= 60_000 ? color.warn.base : undefined}
      />

      <div style={{ flex: 1 }} />

      <button
        onClick={onStop}
        style={{
          background: "transparent",
          color: color.text.secondary,
          border: `1px solid ${color.border.default}`,
          borderRadius: radius.lg,
          padding: "6px 14px",
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        Stop watching
      </button>
    </section>
  );
}

function StripStat({ label, value, tone }: { label: string; value: string; tone?: string | undefined }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6, fontSize: 12 }}>
      <span
        style={{
          fontSize: 10,
          color: color.text.secondary,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: tone ?? color.text.primary,
          fontFamily: font.mono,
          fontVariantNumeric: "tabular-nums",
          fontWeight: 600,
        }}
      >
        {value}
      </span>
    </span>
  );
}
