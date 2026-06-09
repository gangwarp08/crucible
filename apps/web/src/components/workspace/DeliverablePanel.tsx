"use client";
import { useEffect, useState } from "react";
import {
  getDeliverable,
  saveDeliverable,
  type DeliverableData,
  type DeliverableStatus,
} from "@/lib/api";

interface Props {
  sessionId: string;
}

interface Field {
  key: keyof DeliverableData;
  label: string;
  hint: string;
  rows: number;
}

// Field labels/hints come from scenario.json's deliverable_spec.components.
// Hard-coded here to keep the panel self-contained — the labels are
// scenario-pinned and shouldn't change without an explicit scenario edit.
const FIELDS: Field[] = [
  {
    key: "corrected_monthly_revenue",
    label: "Corrected monthly revenue (last 3 months)",
    hint: "A query or script that runs and reproduces the corrected figures for March, April, May 2026.",
    rows: 6,
  },
  {
    key: "root_cause_finding",
    label: "Root-cause finding",
    hint: "What was wrong and why. Identify the cause; quantify the rate + overstatement.",
    rows: 5,
  },
  {
    key: "client_facing_summary",
    label: "Board-ready client-facing summary",
    hint: "One paragraph Dana can take to the board: corrected number, plain-English cause, that this is a recording bug.",
    rows: 6,
  },
  {
    key: "decisions_and_tradeoffs",
    label: "Key decisions and trade-offs",
    hint: "How you handled refunds, timezone, dedup choice; upstream fix recommendation.",
    rows: 5,
  },
];

const EMPTY_DATA: DeliverableData = {
  corrected_monthly_revenue: "",
  root_cause_finding: "",
  client_facing_summary: "",
  decisions_and_tradeoffs: "",
};

export default function DeliverablePanel({ sessionId }: Props) {
  const [data, setData] = useState<DeliverableData>(EMPTY_DATA);
  const [status, setStatus] = useState<DeliverableStatus | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Rehydrate any prior draft/submission on mount.
  useEffect(() => {
    let cancelled = false;
    getDeliverable(sessionId)
      .then((d) => {
        if (cancelled || !d) return;
        setData(d.data);
        setStatus(d.status);
        setUpdatedAt(d.updated_at);
      })
      .catch(() => { /* leave fields blank */ });
    return () => { cancelled = true; };
  }, [sessionId]);

  async function save(nextStatus: DeliverableStatus) {
    if (busy) return;
    if (nextStatus === "submitted") {
      if (!window.confirm(
        "Submit final deliverable? You can resubmit if you change your mind — the latest wins.",
      )) return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const result = await saveDeliverable(sessionId, { status: nextStatus, data });
      setStatus(result.status);
      setUpdatedAt(result.updated_at);
      setFeedback({
        kind: "ok",
        text:
          nextStatus === "submitted"
            ? `Submitted · ${new Date(result.updated_at).toLocaleTimeString()}`
            : `Draft saved · ${new Date(result.updated_at).toLocaleTimeString()}`,
      });
    } catch (err) {
      setFeedback({
        kind: "err",
        text: err instanceof Error ? err.message : "Save failed",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#1e1e1e",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "5px 12px",
          background: "#252526",
          borderBottom: "1px solid #404040",
          fontSize: 11,
          color: "#858585",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span>Deliverable</span>
        {status && (
          <span style={{ color: status === "submitted" ? "#4ec9b0" : "#dcb67a", textTransform: "none", letterSpacing: 0, fontSize: 11 }}>
            {status === "submitted" ? "Submitted" : "Draft"}
            {updatedAt && ` · ${new Date(updatedAt).toLocaleTimeString()}`}
          </span>
        )}
      </div>

      {/* Fields */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px" }}>
        {FIELDS.map((f) => (
          <div key={f.key} style={{ marginBottom: 14 }}>
            <label
              style={{
                display: "block",
                fontSize: 12,
                color: "#cccccc",
                marginBottom: 3,
                fontWeight: 500,
              }}
            >
              {f.label}
            </label>
            <div style={{ fontSize: 11, color: "#858585", marginBottom: 5 }}>
              {f.hint}
            </div>
            <textarea
              value={data[f.key]}
              onChange={(e) => setData({ ...data, [f.key]: e.target.value })}
              rows={f.rows}
              spellCheck={false}
              style={{
                width: "100%",
                background: "#3c3c3c",
                border: "1px solid #555",
                borderRadius: 4,
                color: "#cccccc",
                fontSize: 12,
                fontFamily:
                  f.key === "corrected_monthly_revenue"
                    ? "'SF Mono', Menlo, Consolas, monospace"
                    : "inherit",
                padding: "6px 8px",
                outline: "none",
                resize: "vertical",
                lineHeight: 1.45,
                boxSizing: "border-box",
              }}
            />
          </div>
        ))}
      </div>

      {/* Action bar */}
      <div
        style={{
          padding: "10px 14px",
          borderTop: "1px solid #404040",
          background: "#252526",
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => void save("draft")}
          disabled={busy}
          style={{
            background: busy ? "#37373d" : "#2d2d2d",
            color: busy ? "#555" : "#cccccc",
            border: "1px solid #555",
            borderRadius: 4,
            padding: "5px 14px",
            fontSize: 12,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          Save Draft
        </button>
        <button
          onClick={() => void save("submitted")}
          disabled={busy}
          style={{
            background: busy ? "#37373d" : "#0e639c",
            color: busy ? "#555" : "#fff",
            border: "none",
            borderRadius: 4,
            padding: "5px 14px",
            fontSize: 12,
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          Submit
        </button>
        <div style={{ flex: 1 }} />
        {feedback && (
          <div
            style={{
              fontSize: 11,
              color: feedback.kind === "ok" ? "#4ec9b0" : "#f48771",
            }}
          >
            {feedback.text}
          </div>
        )}
      </div>
    </div>
  );
}
