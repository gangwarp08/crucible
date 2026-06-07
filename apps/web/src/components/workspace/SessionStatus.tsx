"use client";
import { useEffect, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";

function useCountdown(deadline: string | null, onExpire: () => void) {
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

export default function SessionStatus() {
  const { deadline, spend, budget, status, setStatus } = useSessionStore();

  const remaining = useCountdown(
    deadline,
    () => { if (status === "active") setStatus("ended"); },
  );

  const minutes = String(Math.floor(remaining / 60)).padStart(2, "0");
  const seconds = String(remaining % 60).padStart(2, "0");
  const budgetLeft = Math.max(0, budget - spend);
  const pctUsed = budget > 0 ? Math.min(1, spend / budget) : 0;

  const barColor =
    pctUsed > 0.9 ? "#f48771" : pctUsed > 0.7 ? "#dcb67a" : "#4ec9b0";

  const timeColor = remaining < 120 ? "#f48771" : remaining < 300 ? "#dcb67a" : "#858585";

  return (
    <div
      style={{
        padding: "6px 12px",
        background: "#2d2d2d",
        borderBottom: "1px solid #404040",
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexShrink: 0,
        fontSize: 12,
      }}
    >
      {/* Budget bar */}
      <div style={{ flex: 1 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            color: "#858585",
            marginBottom: 3,
            fontSize: 11,
          }}
        >
          <span>
            Budget{" "}
            <span style={{ color: "#555", fontStyle: "italic" }}>(advisory)</span>
          </span>
          <span style={{ color: barColor, fontVariantNumeric: "tabular-nums" }}>
            ${budgetLeft.toFixed(4)} left
          </span>
        </div>
        <div
          style={{
            height: 3,
            background: "#404040",
            borderRadius: 2,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${pctUsed * 100}%`,
              background: barColor,
              transition: "width 0.4s, background 0.4s",
            }}
          />
        </div>
      </div>

      {/* Countdown */}
      <div
        style={{
          fontVariantNumeric: "tabular-nums",
          fontFamily: "monospace",
          fontSize: 13,
          color: timeColor,
          minWidth: 48,
          textAlign: "right",
          flexShrink: 0,
        }}
      >
        {status !== "active" ? (
          <span style={{ color: "#f48771", fontSize: 11 }}>
            {status === "ended" ? "ENDED" : "BUDGET"}
          </span>
        ) : (
          `${minutes}:${seconds}`
        )}
      </div>
    </div>
  );
}
