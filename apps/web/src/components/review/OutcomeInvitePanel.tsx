"use client";

import { useCallback, useEffect, useState } from "react";
import {
  generateOutcomeInvite,
  listOutcomeInvites,
  revokeOutcomeInvite,
  listSessionOutcomes,
  type OutcomeInviteSummary,
  type OutcomeInviteStatus,
  type SessionOutcome,
} from "@/lib/api";

const STATUS_COLOR: Record<OutcomeInviteStatus, string> = {
  active: "#4E8A63",
  submitted: "#58a6ff",
  expired: "#5E6B64",
  revoked: "#BC4B3C",
};

const OUTCOME_LABEL: Record<string, string> = {
  hired: "Hired",
  ramp_weeks: "Ramp time",
  manager_rating_90d: "90-day rating",
  retained_90d: "Retained @ 90d",
};

function fmtOutcomeValue(type: string, value: boolean | number | null): string {
  if (value === null || value === undefined) return "—";
  if (type === "hired" || type === "retained_90d") return value ? "Yes" : "No";
  if (type === "ramp_weeks") return `${value} weeks`;
  if (type === "manager_rating_90d") return `${value} / 5`;
  return String(value);
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return iso;
  }
}

interface Props {
  sessionId: string;
  /** The candidate's overall assessment score, shown next to the real-world
   *  outcomes so "scored X, real outcome Y" reads in one place. */
  overallScore?: number | null;
}

/** Admin panel on the review page: generate a single-use partner-feedback link
 *  for this session, copy it, and see the status of links already issued. The
 *  raw link is only shown ONCE (only its hash is stored server-side). */
export default function OutcomeInvitePanel({ sessionId, overallScore }: Props) {
  const [invites, setInvites] = useState<OutcomeInviteSummary[]>([]);
  const [outcomes, setOutcomes] = useState<SessionOutcome[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freshLink, setFreshLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [inv, outs] = await Promise.all([
        listOutcomeInvites(sessionId),
        listSessionOutcomes(sessionId),
      ]);
      setInvites(inv);
      setOutcomes(outs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onGenerate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    setCopied(false);
    try {
      const { token } = await generateOutcomeInvite(sessionId);
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      setFreshLink(`${origin}/feedback/${token}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }, [sessionId, refresh]);

  const onCopy = useCallback(async () => {
    if (!freshLink) return;
    try {
      await navigator.clipboard.writeText(freshLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — user can select the text manually */
    }
  }, [freshLink]);

  const onRevoke = useCallback(
    async (id: string) => {
      try {
        await revokeOutcomeInvite(id);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  return (
    <section
      style={{
        background: "#FBF6EA",
        border: "1px solid #E7DDCB",
        borderRadius: 10,
        padding: 16,
        marginBottom: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Partner feedback</h2>
        <button
          onClick={() => void onGenerate()}
          disabled={generating}
          style={{
            background: generating ? "#E0D6C4" : "#C67C5B",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            padding: "6px 12px",
            fontSize: 13,
            cursor: generating ? "default" : "pointer",
          }}
        >
          {generating ? "Generating…" : "Generate link"}
        </button>
      </div>
      <p style={{ fontSize: 12, color: "#5E6B64", margin: "0 0 12px" }}>
        Create a single-use link to send a hiring partner so they can report real-world outcomes
        (hired, ramp time, 90-day rating, retention) for this candidate. No account needed.
      </p>

      {error && (
        <p style={{ color: "#BC4B3C", fontSize: 12, marginBottom: 12 }}>Error: {error}</p>
      )}

      {/* Captured real-world outcomes — the payoff: score vs. reality in one place. */}
      {outcomes.length > 0 && (
        <div
          style={{
            background: "#FBF7EF",
            border: "1px solid #3F6E4F",
            borderRadius: 6,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              marginBottom: 8,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: "#4E8A63" }}>
              Reported outcomes
            </span>
            {overallScore !== null && overallScore !== undefined && (
              <span style={{ fontSize: 12, color: "#5E6B64" }}>
                assessment score:{" "}
                <strong style={{ color: "#28352F" }}>{overallScore.toFixed(2)} / 5</strong>
              </span>
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {outcomes.map((o, i) => (
              <div
                key={`${o.outcome_type}-${i}`}
                style={{
                  background: "#FBF6EA",
                  border: "1px solid #E7DDCB",
                  borderRadius: 6,
                  padding: "6px 10px",
                  minWidth: 110,
                }}
                title={`source: ${o.source} · ${fmtDate(o.captured_at)}`}
              >
                <div style={{ fontSize: 11, color: "#5E6B64" }}>
                  {OUTCOME_LABEL[o.outcome_type] ?? o.outcome_type}
                </div>
                <div style={{ fontSize: 15, fontWeight: 600, color: "#28352F" }}>
                  {fmtOutcomeValue(o.outcome_type, o.value)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {freshLink && (
        <div
          style={{
            background: "#FBF7EF",
            border: "1px solid #C67C5B55",
            borderRadius: 6,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 12, color: "#5E6B64", marginBottom: 6 }}>
            Copy this link now — it won&apos;t be shown again:
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <code
              style={{
                flex: 1,
                fontSize: 12,
                color: "#28352F",
                wordBreak: "break-all",
                fontFamily: "var(--font-mono, ui-monospace, monospace)",
              }}
            >
              {freshLink}
            </code>
            <button
              onClick={() => void onCopy()}
              style={{
                background: copied ? "#3F6E4F" : "#D8CCB6",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                padding: "6px 12px",
                fontSize: 12,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p style={{ fontSize: 12, color: "#5E6B64" }}>Loading…</p>
      ) : invites.length === 0 ? (
        <p style={{ fontSize: 12, color: "#5E6B64", margin: 0 }}>No links issued yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ color: "#5E6B64", textAlign: "left" }}>
              <th style={{ padding: "4px 8px", fontWeight: 500 }}>Status</th>
              <th style={{ padding: "4px 8px", fontWeight: 500 }}>Outcomes requested</th>
              <th style={{ padding: "4px 8px", fontWeight: 500 }}>Expires</th>
              <th style={{ padding: "4px 8px", fontWeight: 500 }}></th>
            </tr>
          </thead>
          <tbody>
            {invites.map((inv) => (
              <tr key={inv.id} style={{ borderTop: "1px solid #E7DDCB" }}>
                <td style={{ padding: "6px 8px" }}>
                  <span style={{ color: STATUS_COLOR[inv.status], fontWeight: 600 }}>{inv.status}</span>
                </td>
                <td style={{ padding: "6px 8px", color: "#28352F" }}>{inv.outcome_types.join(", ")}</td>
                <td style={{ padding: "6px 8px", color: "#5E6B64" }}>{fmtDate(inv.expires_at)}</td>
                <td style={{ padding: "6px 8px", textAlign: "right" }}>
                  {inv.status === "active" && (
                    <button
                      onClick={() => void onRevoke(inv.id)}
                      style={{
                        background: "transparent",
                        color: "#BC4B3C",
                        border: "1px solid #BC4B3C55",
                        borderRadius: 5,
                        padding: "3px 8px",
                        fontSize: 11,
                        cursor: "pointer",
                      }}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
