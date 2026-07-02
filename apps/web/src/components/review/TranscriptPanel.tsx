"use client";
import { useState } from "react";
import type { ReviewTranscriptRow } from "@/lib/api";
import { formatSpendPrecise } from "./format";

interface Props {
  transcript: ReviewTranscriptRow[];
}

function MessageBubble({ row }: { row: ReviewTranscriptRow }) {
  const isUser = row.role === "user";
  const isAssistant = row.role === "assistant";

  return (
    <div
      id={`turn-${row.id}`}
      style={{
        scrollMarginTop: 16,
        padding: "8px 16px",
        display: "flex",
        flexDirection: "column",
        alignItems: isUser ? "flex-end" : "flex-start",
        gap: 4,
      }}
    >
      <div
        style={{
          maxWidth: "85%",
          padding: "8px 12px",
          borderRadius: isUser ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
          background: isUser ? "rgba(198, 124, 91, 0.18)" : "#FFFDF9",
          color: "#28352F",
          fontSize: 13,
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {row.content}
      </div>
      {isAssistant && (row.prompt_tokens !== null || row.cost_usd !== null) && (
        <div
          style={{
            fontSize: 10,
            color: "#8A9389",
            fontFamily: "var(--font-mono, ui-monospace, JetBrains Mono, monospace)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {row.prompt_tokens !== null && row.completion_tokens !== null && (
            <span>tokens {row.prompt_tokens}/{row.completion_tokens} · </span>
          )}
          {row.cost_usd !== null && <span>cost {formatSpendPrecise(row.cost_usd)} · </span>}
          {row.latency_ms !== null && <span>latency {row.latency_ms}ms</span>}
        </div>
      )}
    </div>
  );
}

export default function TranscriptPanel({ transcript }: Props) {
  const [systemOpen, setSystemOpen] = useState(false);

  const systemRows = transcript.filter((t) => t.role === "system");
  const turnRows = transcript.filter((t) => t.role !== "system");

  return (
    <section
      style={{
        background: "#FBF6EA",
        border: "1px solid #DED3BF",
        borderRadius: 6,
        marginBottom: 16,
        overflow: "hidden",
      }}
    >
      <header
        style={{
          padding: "10px 16px",
          background: "#FFFDF9",
          borderBottom: "1px solid #DED3BF",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: "#5E6B64", letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Transcript
        </span>
        <span style={{ fontSize: 11, color: "#8A9389" }}>{turnRows.length} turns</span>
      </header>

      {systemRows.length > 0 && (
        <div style={{ borderBottom: "1px solid #E5DBC9" }}>
          <button
            onClick={() => setSystemOpen((o) => !o)}
            style={{
              width: "100%",
              textAlign: "left",
              padding: "8px 16px",
              background: "transparent",
              border: "none",
              color: "#5E6B64",
              fontSize: 11,
              cursor: "pointer",
              letterSpacing: "0.04em",
            }}
          >
            {systemOpen ? "▾" : "▸"} System prompt {systemOpen ? "(hide)" : "(hidden)"}
          </button>
          {systemOpen &&
            systemRows.map((r) => (
              <div
                key={r.id}
                id={`turn-${r.id}`}
                style={{
                  scrollMarginTop: 16,
                  padding: "8px 16px 12px 32px",
                  fontSize: 12,
                  color: "#5E6B64",
                  lineHeight: 1.55,
                  whiteSpace: "pre-wrap",
                  fontFamily: "var(--font-mono, ui-monospace, JetBrains Mono, monospace)",
                  background: "#FBF7EF",
                  borderTop: "1px solid #E5DBC9",
                }}
              >
                {r.content}
              </div>
            ))}
        </div>
      )}

      <div style={{ padding: "12px 0", maxHeight: 480, overflowY: "auto" }}>
        {turnRows.length === 0 ? (
          <div style={{ padding: "24px 16px", color: "#8A9389", fontSize: 13, textAlign: "center" }}>
            No turns
          </div>
        ) : (
          turnRows.map((r) => <MessageBubble key={r.id} row={r} />)
        )}
      </div>
    </section>
  );
}

