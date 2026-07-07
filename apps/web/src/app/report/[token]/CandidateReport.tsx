"use client";
// P4.2 — public candidate report, rendered from the external-safe subset the
// server returns for a share token (GET /api/report/:token). Lean read-only
// take on the Scorecard visual language — deliberately NOT the Scorecard
// component (no re-evaluate, no cap resolution, no event links: shared mode
// has no event data, so evidence seq numbers render as static badges).
//
// PDF export = print CSS (signed-off: no server rendering). Screen keeps the
// brand dark theme; @media print flips to white paper / black ink and hides
// the buttons.
import { useEffect, useState } from "react";
import {
  getSharedReport,
  NotFoundError,
  ReportGoneError,
  type SharedReport,
  type SharedReportCompetency,
} from "@/lib/api";
import { AI_FLUENCY_LABELS, AI_FLUENCY_SPECTRUM, aiFluencyLabel } from "@/lib/ai-fluency";
import { color, radius, font, scoreColor } from "@/styles/tokens";

const BAND_LABEL: Record<string, string> = { easy: "Easy", mid: "Mid", hard: "Hard" };

// Print stylesheet: white paper, black ink, no chrome. The universal override
// is intentional — every component below uses inline dark-theme styles, and
// print must win over all of them.
const PRINT_CSS = `
@media print {
  .no-print { display: none !important; }
  body { background: #ffffff !important; }
  .report-root { background: #ffffff !important; min-height: 0 !important; }
  .report-root, .report-root * {
    color: #000000 !important;
    background: #ffffff !important;
    border-color: #bbbbbb !important;
    box-shadow: none !important;
    text-shadow: none !important;
  }
}
`;

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; report: SharedReport }
  | { kind: "gone"; reason: "expired" | "revoked" }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

export default function CandidateReport({ token }: { token: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const report = await getSharedReport(token);
        if (!cancelled) setState({ kind: "ok", report });
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ReportGoneError) setState({ kind: "gone", reason: e.reason });
        else if (e instanceof NotFoundError) setState({ kind: "not_found" });
        else setState({ kind: "error", message: e instanceof Error ? e.message : "Failed to load report" });
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  if (state.kind !== "ok") {
    return (
      <Shell>
        {state.kind === "loading" && <Notice title="Loading report…" body="" />}
        {state.kind === "not_found" && (
          <Notice title="Report not found" body="This report link is invalid or no longer exists." />
        )}
        {state.kind === "gone" && (
          <Notice
            title={state.reason === "revoked" ? "Link revoked" : "Link expired"}
            body="Ask the person who shared this report for a fresh link."
          />
        )}
        {state.kind === "error" && <Notice title="Failed to load report" body={state.message} />}
      </Shell>
    );
  }

  const r = state.report;
  return (
    <Shell>
      {/* Header */}
      <header style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontSize: 11, color: color.text.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>
              Candidate assessment report · asaya
            </div>
            <h1 style={{ fontSize: 24, fontWeight: 600, color: color.text.primary, margin: 0, letterSpacing: "-0.3px" }}>
              {r.candidate_label ?? "Candidate"}
            </h1>
            <div style={{ fontSize: 13, color: color.text.secondary, marginTop: 6 }}>
              {r.scenario.title} · {r.scenario.role.toUpperCase()}
              {r.difficulty_band && <> · {BAND_LABEL[r.difficulty_band] ?? r.difficulty_band} band</>}
            </div>
            <div style={{ fontSize: 12, color: color.text.muted, marginTop: 4 }}>
              {formatDate(r.created_at)}
              {r.ended_at && <> — {formatDate(r.ended_at)}</>}
            </div>
          </div>
          <button className="no-print" onClick={() => window.print()} style={exportBtn}>
            Export PDF
          </button>
        </div>
      </header>

      {/* Exclusion banner */}
      {r.scorable === false && (
        <Panel>
          <div style={{ fontSize: 12, fontWeight: 600, color: color.warn.base, letterSpacing: "0.04em" }}>
            EXCLUDED FROM SCORING{r.exclusion_reason ? ` · ${r.exclusion_reason}` : ""}
          </div>
          <div style={{ fontSize: 12, color: color.text.secondary, marginTop: 5, lineHeight: 1.5 }}>
            This session did not meet the scorable floor. Any score shown is informational
            only and should not be read as a measure of the candidate.
          </div>
        </Panel>
      )}

      {/* Overall + AI-Fluency */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <Panel style={{ flex: "1 1 220px", marginBottom: 0 }}>
          <PanelLabel>Overall score</PanelLabel>
          {r.overall_score !== null ? (
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: 34, fontWeight: 600, color: scoreColor(r.overall_score), fontFamily: font.mono }}>
                {r.overall_score.toFixed(2)}
              </span>
              <span style={{ fontSize: 14, color: color.text.secondary }}>/ 5.00</span>
            </div>
          ) : (
            <div style={{ fontSize: 14, color: color.text.muted }}>Not evaluated</div>
          )}
          {r.verification.defense_outcome && (
            <div style={{ fontSize: 12, color: color.text.secondary, marginTop: 8 }}>
              Verification: <strong style={{ color: color.text.primary }}>{r.verification.defense_outcome}</strong>
              {(r.verification.cap_status === "confirmed" || r.verification.cap_status === "applied") &&
                " · score capped after verification"}
            </div>
          )}
        </Panel>

        <Panel style={{ flex: "2 1 320px", marginBottom: 0 }}>
          <PanelLabel>AI-Fluency Index (informational)</PanelLabel>
          <Spectrum placement={r.ai_fluency.placement} />
          <div style={{ fontSize: 11, color: color.text.muted, marginTop: 8, lineHeight: 1.5 }}>
            A presentation of how the candidate worked with AI during the assessment —
            it does not change any score.
          </div>
        </Panel>
      </div>

      {/* Competencies */}
      <Panel>
        <PanelLabel>Competencies</PanelLabel>
        {r.competencies.length === 0 ? (
          <div style={{ fontSize: 13, color: color.text.muted }}>No competency breakdown available.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {r.competencies.map((c) => (
              <CompetencyCard key={c.key} item={c} />
            ))}
          </div>
        )}
      </Panel>

      {/* Suspicion — informational */}
      <Panel>
        <PanelLabel>Session integrity (informational)</PanelLabel>
        <div style={{ fontSize: 13, color: color.text.primary }}>
          Suspicion score:{" "}
          <span style={{ fontFamily: font.mono, fontWeight: 600, color: r.suspicion.score >= 40 ? color.warn.base : color.text.primary }}>
            {r.suspicion.score}/100
          </span>
        </div>
        {r.suspicion.factors.length > 0 && (
          <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: color.text.secondary, lineHeight: 1.7 }}>
            {r.suspicion.factors.map((f) => (
              <li key={f.kind}>
                {f.kind.replace(/_/g, " ")} × {f.count} (+{f.contribution})
              </li>
            ))}
          </ul>
        )}
        <div style={{ fontSize: 11, color: color.text.muted, marginTop: 8, lineHeight: 1.5 }}>
          Passive browser signals aggregated for context. Informational only — this number
          is never part of the assessment score.
        </div>
      </Panel>

      <footer style={{ fontSize: 11, color: color.text.muted, marginTop: 20, lineHeight: 1.6 }}>
        Generated by asaya · simulation-based assessment. This shared report contains the
        external-safe summary only. Link expires {formatDate(r.share.expires_at)}.
      </footer>
    </Shell>
  );
}

// ── pieces ───────────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main
      className="report-root"
      style={{
        minHeight: "100vh",
        background: color.bg.page,
        color: color.text.primary,
        fontFamily: font.sans,
        padding: "40px 24px 64px",
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
      <div style={{ maxWidth: 860, margin: "0 auto" }}>{children}</div>
    </main>
  );
}

function Panel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <section
      style={{
        background: color.bg.panel,
        border: `1px solid ${color.border.default}`,
        borderRadius: radius.md,
        padding: "14px 16px",
        marginBottom: 12,
        ...style,
      }}
    >
      {children}
    </section>
  );
}

function PanelLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: color.text.secondary,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

function Spectrum({ placement }: { placement: SharedReport["ai_fluency"]["placement"] }) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {AI_FLUENCY_SPECTRUM.map((band) => {
        const active = band === placement;
        return (
          <div
            key={band}
            style={{
              flex: 1,
              textAlign: "center",
              padding: "8px 6px",
              borderRadius: radius.lg,
              border: `1px solid ${active ? color.accent.base : color.border.subtle}`,
              background: active ? color.accent.soft : "transparent",
              color: active ? color.accent.base : color.text.muted,
              fontSize: 12,
              fontWeight: active ? 600 : 400,
            }}
          >
            {AI_FLUENCY_LABELS[band]}
            {active && " ●"}
          </div>
        );
      })}
      {placement === null && (
        <div style={{ alignSelf: "center", fontSize: 12, color: color.text.muted, paddingLeft: 6 }}>
          {aiFluencyLabel(null)}
        </div>
      )}
    </div>
  );
}

function CompetencyCard({ item }: { item: SharedReportCompetency }) {
  const notAssessed = !item.assessed || item.score === null;
  const c = notAssessed ? color.text.muted : scoreColor(item.score!);
  return (
    <div
      style={{
        background: color.bg.page,
        border: `1px solid ${color.border.subtle}`,
        borderRadius: radius.lg,
        padding: "10px 12px",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: color.text.primary }}>
          {prettyCompetency(item.key)}
        </span>
        <span style={{ fontSize: notAssessed ? 11 : 14, fontWeight: 600, color: c, fontFamily: font.mono }}>
          {notAssessed ? "NOT ASSESSED" : `${item.score}/5`}
        </span>
      </div>
      {item.rationale && (
        <div style={{ fontSize: 12, color: color.text.primary, lineHeight: 1.55, marginBottom: item.evidence.length > 0 ? 8 : 0 }}>
          {item.rationale}
        </div>
      )}
      {item.evidence.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {item.evidence.map((ev, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 11.5, lineHeight: 1.5 }}>
              {/* Static badge — shared mode ships no event data to link into. */}
              <span
                style={{
                  color: color.text.muted,
                  fontFamily: font.mono,
                  fontSize: 10,
                  border: `1px solid ${color.border.subtle}`,
                  borderRadius: radius.lg,
                  padding: "1px 6px",
                  flexShrink: 0,
                }}
              >
                seq {ev.event_seq}
              </span>
              <span style={{ color: color.text.secondary }}>{ev.note}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div
      style={{
        textAlign: "center",
        padding: 48,
        background: color.bg.panel,
        border: `1px solid ${color.border.default}`,
        borderRadius: radius.md,
        maxWidth: 520,
        margin: "10vh auto 0",
      }}
    >
      <div style={{ fontSize: 16, color: color.text.primary, marginBottom: 8 }}>{title}</div>
      {body && <div style={{ fontSize: 13, color: color.text.secondary, lineHeight: 1.6 }}>{body}</div>}
    </div>
  );
}

// Local copies (this page lives outside components/review — keep the public
// report self-contained rather than importing review internals).
function prettyCompetency(key: string): string {
  return key
    .split("_")
    .map((w) => (w === "ai" ? "AI" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const exportBtn: React.CSSProperties = {
  background: color.accent.base,
  color: color.text.inverse,
  border: "none",
  borderRadius: radius.lg,
  padding: "8px 18px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  flexShrink: 0,
};
