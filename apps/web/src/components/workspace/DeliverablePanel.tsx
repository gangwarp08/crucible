"use client";
import { useEffect, useState } from "react";
import {
  getDeliverable, saveDeliverable,
  type DeliverableData, type DeliverableStatus,
} from "@/lib/api";
import { color, font, radius } from "@/styles/tokens";
import Button from "@/components/ui/Button";
import Pill from "@/components/ui/Pill";

interface Props { sessionId: string; }

interface Field {
  key: keyof DeliverableData;
  label: string;
  hint: string;
  rows: number;
}

const FIELDS: Field[] = [
  { key: "corrected_monthly_revenue", label: "Corrected monthly revenue (last 3 months)", hint: "A query or script that runs and reproduces the corrected figures for March, April, May 2026.", rows: 6 },
  { key: "root_cause_finding",        label: "Root-cause finding",                         hint: "What was wrong and why. Identify the cause; quantify the rate + overstatement.",                 rows: 5 },
  { key: "client_facing_summary",     label: "Board-ready client-facing summary",          hint: "One paragraph Dana can take to the board: corrected number, plain-English cause, recording bug.", rows: 6 },
  { key: "decisions_and_tradeoffs",   label: "Key decisions and trade-offs",               hint: "How you handled refunds, timezone, dedup choice; upstream fix recommendation.",                  rows: 5 },
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
      if (!window.confirm("Submit final deliverable? You can resubmit if you change your mind — the latest wins.")) return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const result = await saveDeliverable(sessionId, { status: nextStatus, data });
      setStatus(result.status);
      setUpdatedAt(result.updated_at);
      setFeedback({
        kind: "ok",
        text: nextStatus === "submitted"
          ? `Submitted · ${new Date(result.updated_at).toLocaleTimeString()}`
          : `Draft saved · ${new Date(result.updated_at).toLocaleTimeString()}`,
      });
    } catch (err) {
      setFeedback({ kind: "err", text: err instanceof Error ? err.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: color.bg.page, overflow: "hidden" }}>
      <div style={{
        padding: "10px 14px",
        background: color.bg.elevated,
        borderBottom: `1px solid ${color.border.subtle}`,
        flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: color.text.secondary,
          letterSpacing: "0.08em", textTransform: "uppercase",
        }}>Deliverable</div>
        {status && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Pill tone={status === "submitted" ? "success" : "warn"}>
              {status === "submitted" ? "Submitted" : "Draft"}
            </Pill>
            {updatedAt && (
              <span style={{ fontSize: 11, color: color.text.muted, fontFamily: font.mono, fontVariantNumeric: "tabular-nums" }}>
                {new Date(updatedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "16px 16px 24px" }}>
        {FIELDS.map((f) => (
          <div key={f.key} style={{ marginBottom: 18 }}>
            <label style={{
              display: "block", fontSize: 13, color: color.text.primary,
              marginBottom: 4, fontWeight: 600,
            }}>
              {f.label}
            </label>
            <div style={{ fontSize: 11, color: color.text.muted, marginBottom: 6, lineHeight: 1.5 }}>
              {f.hint}
            </div>
            <textarea
              value={data[f.key]}
              onChange={(e) => setData({ ...data, [f.key]: e.target.value })}
              rows={f.rows}
              spellCheck={false}
              style={{
                width: "100%",
                background: color.bg.input,
                border: `1px solid ${color.border.default}`,
                borderRadius: radius.sm,
                color: color.text.primary,
                fontSize: 12,
                fontFamily: f.key === "corrected_monthly_revenue" ? font.mono : font.sans,
                padding: "8px 10px",
                outline: "none",
                resize: "vertical",
                lineHeight: 1.5,
                boxSizing: "border-box",
              }}
            />
          </div>
        ))}
      </div>

      <div style={{
        padding: "10px 14px",
        borderTop: `1px solid ${color.border.subtle}`,
        background: color.bg.panel,
        display: "flex", alignItems: "center", gap: 10,
        flexShrink: 0,
      }}>
        <Button variant="secondary" size="md" disabled={busy} onClick={() => void save("draft")}>
          Save draft
        </Button>
        <Button variant="primary" size="md" disabled={busy} onClick={() => void save("submitted")}>
          Submit
        </Button>
        <div style={{ flex: 1 }} />
        {feedback && (
          <div style={{
            fontSize: 11,
            color: feedback.kind === "ok" ? color.success.base : color.error.base,
            fontFamily: font.mono,
            fontVariantNumeric: "tabular-nums",
          }}>
            {feedback.text}
          </div>
        )}
      </div>
    </div>
  );
}
