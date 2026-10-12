"use client";
// Verification confidence review surface (slice V5). Mirrors SuspicionPanel's
// posture exactly: recruiter-only, strictly informational, isolated from
// competency scoring — and the panel says so. Framing rule: this is
// "verification confidence with evidence", never "fraud detected"; a low
// score means thin evidence, not an accusation.
//
// Zero-impact on older deploys: when the server lacks the verification route,
// getVerificationReport returns null and the panel renders nothing.
import { useEffect, useState } from "react";
import { getVerificationReport, type VerificationReport } from "@/lib/api";
import { color, radius, font } from "@/styles/tokens";

interface Props {
  sessionId: string;
}

// Confidence is 0–100 where HIGH is good (same polarity as competency scores,
// inverse of suspicion).
function confidenceColor(score: number): string {
  if (score >= 70) return color.success.base;
  if (score >= 40) return color.accent.base;
  if (score >= 20) return color.warn.base;
  return color.error.base;
}

const COMPONENT_LABELS: Record<string, string> = {
  identity_verified: "Identity (ID ↔ selfie)",
  continuity: "Continuity (same person)",
  environment: "Environment",
  paste_provenance: "Paste provenance",
  geo_consistency: "Network consistency",
  typing_stability: "Typing stability",
  bgv: "Claims verification",
};

type Fetch =
  | { kind: "loading" }
  | { kind: "loaded"; report: VerificationReport | null };

export default function VerificationPanel({ sessionId }: Props) {
  const [fetch, setFetch] = useState<Fetch>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setFetch({ kind: "loading" });
    void getVerificationReport(sessionId).then((report) => {
      if (!cancelled) setFetch({ kind: "loaded", report });
    });
    return () => { cancelled = true; };
  }, [sessionId]);

  if (fetch.kind === "loading") return null;
  const report = fetch.report;
  // Nothing assessable and no components → older server or pre-pipeline
  // session; render nothing (same quiet posture as SuspicionPanel).
  if (!report || report.components.length === 0) return null;

  const scoreTone = report.score === null ? color.text.muted : confidenceColor(report.score);

  return (
    <div
      style={{
        background: color.bg.panel,
        border: `1px solid ${color.border.default}`,
        borderRadius: radius.md,
        padding: 16,
        fontFamily: font.sans,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: color.text.primary }}>
          Verification confidence
        </span>
        <span style={{ fontSize: 20, fontWeight: 700, color: scoreTone }}>
          {report.score === null ? "—" : report.score}
        </span>
        <span style={{ fontSize: 11, color: color.text.muted }}>
          / 100 · v{report.version}
          {report.assessedMax > 0 && report.assessedMax < 100
            ? ` · ${report.assessedMax} of 100 points assessable`
            : ""}
        </span>
      </div>
      <div style={{ fontSize: 11, color: color.text.muted, marginBottom: 12, lineHeight: 1.5 }}>
        Informational only — aggregates identity, continuity, and environment
        evidence. Never affects competency scores. A low value means thin
        evidence, not misconduct.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {report.components.map((c) => {
          const label = COMPONENT_LABELS[c.kind] ?? c.kind;
          const assessed = c.status === "assessed";
          const frac = assessed && c.max > 0 ? c.points / c.max : 0;
          return (
            <div key={c.kind} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 170, fontSize: 12, color: assessed ? color.text.secondary : color.text.muted }}>
                {label}
              </span>
              <div
                style={{
                  flex: 1, height: 6, borderRadius: 3,
                  background: color.bg.input,
                  overflow: "hidden",
                }}
              >
                {assessed && (
                  <div
                    style={{
                      width: `${Math.round(frac * 100)}%`,
                      height: "100%",
                      background: confidenceColor(Math.round(frac * 100)),
                    }}
                  />
                )}
              </div>
              <span style={{ width: 44, fontSize: 11, textAlign: "right", color: assessed ? color.text.secondary : color.text.muted }}>
                {assessed ? `${c.points}/${c.max}` : "n/a"}
              </span>
              <span
                style={{ flex: 1.4, fontSize: 11, color: color.text.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={c.note + (c.evidenceSeqs.length > 0 ? ` (events: ${c.evidenceSeqs.join(", ")})` : "")}
              >
                {c.note}
                {c.evidenceSeqs.length > 0 ? ` · seq ${c.evidenceSeqs.slice(0, 6).join(", ")}${c.evidenceSeqs.length > 6 ? "…" : ""}` : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
