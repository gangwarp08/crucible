"use client";
import { useEffect, useState } from "react";
import {
  getDeliverable, saveDeliverable,
  type DeliverableData, type DeliverableStatus,
} from "@/lib/api";
import { color, font, radius } from "@/styles/tokens";
import { useSessionStore, isWorkspaceWritable } from "@/stores/sessionStore";
import Button from "@/components/ui/Button";
import Pill from "@/components/ui/Pill";

interface Props { sessionId: string; }

interface Field {
  key: keyof DeliverableData;
  label: string;
  rows: number;
}

const FIELDS: Field[] = [
  { key: "corrected_monthly_revenue", label: "Corrected monthly revenue (last 3 months)", rows: 6 },
  { key: "root_cause_finding",        label: "Root-cause finding",                        rows: 5 },
  { key: "client_facing_summary",     label: "Board-ready client-facing summary",         rows: 6 },
  { key: "decisions_and_tradeoffs",   label: "Decisions, trade-offs, and prioritization", rows: 5 },
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
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const setSessionStatus = useSessionStore((s) => s.setStatus);
  const sessionStatus = useSessionStore((s) => s.status);
  const writable = isWorkspaceWritable(sessionStatus);

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

  /** Save draft is iterative — persists the current form as status='draft'
   *  and does NOT end the session. The candidate can keep working. */
  async function saveDraft() {
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await saveDeliverable(sessionId, { status: "draft", data });
      setStatus(result.status);
      setUpdatedAt(result.updated_at);
      setFeedback({
        kind: "ok",
        text: `Draft saved · ${new Date(result.updated_at).toLocaleTimeString()}`,
      });
    } catch (err) {
      setFeedback({ kind: "err", text: err instanceof Error ? err.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  }

  /** Submit is FINAL — persists status='submitted' (the immutable snapshot),
   *  the server ends + scores the session, and the candidate lands on the
   *  "submitted" screen. No resubmit; the confirmation makes that explicit. */
  async function submit() {
    if (busy || !writable) return;
    setConfirming(false);
    setBusy(true);
    setFeedback(null);
    try {
      const result = await saveDeliverable(sessionId, { status: "submitted", data });
      setStatus(result.status);
      setUpdatedAt(result.updated_at);
      // Show the submitted / end screen immediately; the server tears down +
      // scores the session in the background.
      setSessionStatus("ended");
    } catch (err) {
      setFeedback({ kind: "err", text: err instanceof Error ? err.message : "Submit failed" });
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
            <textarea
              value={data[f.key]}
              onChange={(e) => setData({ ...data, [f.key]: e.target.value })}
              rows={f.rows}
              spellCheck={false}
              readOnly={!writable}
              disabled={!writable}
              style={{
                width: "100%",
                opacity: writable ? 1 : 0.6,
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
        <Button variant="secondary" size="md" disabled={busy || !writable} onClick={() => void saveDraft()}>
          Save draft
        </Button>
        {!writable && (
          <span style={{ fontSize: 11, color: color.text.muted }}>
            Locked — submitted for review
          </span>
        )}
        <div style={{ flex: 1 }} />
        {feedback && (
          <div style={{
            fontSize: 11,
            color: feedback.kind === "ok" ? color.success.base : color.error.base,
            fontFamily: font.mono,
            fontVariantNumeric: "tabular-nums",
            marginRight: 8,
          }}>
            {feedback.text}
          </div>
        )}
        {confirming ? (
          // Non-blocking inline confirmation (replaces window.confirm, which
          // froze the main thread for seconds → the submit INP jank).
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: color.text.secondary, maxWidth: 320, lineHeight: 1.4 }}>
              This submits your work and ends the session. This is final — no re-editing.
            </span>
            <Button variant="secondary" size="md" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="md" disabled={busy || !writable} onClick={() => void submit()}>
              {busy ? "Submitting…" : "Confirm submit"}
            </Button>
          </div>
        ) : (
          <Button
            variant="primary"
            size="md"
            disabled={busy || !writable}
            onClick={() => setConfirming(true)}
            title="Submit and lock your work for review. This is final."
          >
            Submit
          </Button>
        )}
      </div>
    </div>
  );
}
