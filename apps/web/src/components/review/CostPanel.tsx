"use client";
import type { ReviewCostRow } from "@/lib/api";
import { asNumber, formatSpend, formatSpendPrecise, formatDateTime } from "./format";

interface Props {
  cost: ReviewCostRow[];
  totalSpend: number | string;
  budget: number | string;
}

export default function CostPanel({ cost, totalSpend, budget }: Props) {
  const total = asNumber(totalSpend);
  const budgetN = asNumber(budget);
  const pctUsed = budgetN > 0 ? Math.min(1, total / budgetN) : 0;
  const barColor =
    pctUsed > 0.9 ? "#ff7a7a" : pctUsed > 0.7 ? "#e0b66e" : "#56d6a8";

  return (
    <section
      style={{
        background: "#15151b",
        border: "1px solid #2a2a36",
        borderRadius: 6,
        marginBottom: 16,
        overflow: "hidden",
      }}
    >
      <header
        style={{
          padding: "10px 16px",
          background: "#1c1c24",
          borderBottom: "1px solid #2a2a36",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: "#9999a3", letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Cost
        </span>
      </header>

      <div style={{ padding: "12px 16px", borderBottom: "1px solid #22222b" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 12,
            color: "#9999a3",
            marginBottom: 6,
          }}
        >
          <span>Total spend</span>
          <span style={{ color: barColor, fontFamily: "var(--font-mono, ui-monospace, JetBrains Mono, monospace)", fontVariantNumeric: "tabular-nums" }}>
            {formatSpend(total)} / {formatSpend(budgetN)}
          </span>
        </div>
        <div
          style={{
            height: 4,
            background: "#2a2a36",
            borderRadius: 2,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${pctUsed * 100}%`,
              background: barColor,
            }}
          />
        </div>
      </div>

      <div style={{ maxHeight: 320, overflowY: "auto" }}>
        {cost.length === 0 ? (
          <div style={{ padding: 24, color: "#6a6a78", fontSize: 13, textAlign: "center" }}>
            No cost rows
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ background: "#0c0c10" }}>
                <th style={th}>Time</th>
                <th style={{ ...th, textAlign: "right" }}>Tokens</th>
                <th style={{ ...th, textAlign: "right" }}>Cost</th>
                <th style={{ ...th, textAlign: "right" }}>Cumul.</th>
              </tr>
            </thead>
            <tbody>
              {cost.map((c) => (
                <tr key={c.id} style={{ borderBottom: "1px solid #22222b" }}>
                  <td style={td}>{formatDateTime(c.ts)}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    {c.prompt_tokens ?? "?"}/{c.completion_tokens ?? "?"}
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>{formatSpendPrecise(c.cost_usd)}</td>
                  <td style={{ ...td, textAlign: "right", color: "#e6e6ea" }}>
                    {formatSpendPrecise(c.cumulative_spend_usd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 12px",
  fontSize: 10,
  fontWeight: 600,
  color: "#9999a3",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  borderBottom: "1px solid #2a2a36",
};

const td: React.CSSProperties = {
  padding: "6px 12px",
  color: "#9999a3",
  fontFamily: "var(--font-mono, ui-monospace, JetBrains Mono, monospace)",
  fontVariantNumeric: "tabular-nums",
  fontSize: 11,
};
