"use client";
// Proctoring v1 review surface: Suspicion Score + factor breakdown + an
// integrity-event mini-timeline. Strictly informational — the integrity
// channel is isolated from competency evidence/evaluations by design, and
// this panel says so prominently.
//
// Zero-impact on older deploys: when the server lacks the suspicion route,
// getSuspicionReport returns null; with no integrity events either, the
// panel renders nothing at all.
import { useEffect, useState } from "react";
import {
  getSuspicionReport,
  type SuspicionReport,
  type SuspicionIdentity,
  type SuspicionNetwork,
  type IntegrityTimelineEvent,
  type ReviewEvent,
} from "@/lib/api";
import { color, radius, font } from "@/styles/tokens";
import { formatRelativeMs } from "./format";

interface Props {
  sessionId: string;
  /** Full event list from the session detail bundle — integrity.* rows are
   *  filtered out here for the mini-timeline (they're ordinary events rows). */
  events: ReviewEvent[];
  sessionStart: string;
}

// Suspicion is 0–100 where HIGH is bad — the inverse of the 1–5 competency
// scale — so scoreColor() can't be reused directly; same palette, inverted.
// Exported: SessionDetail's overview header reuses it for the suspicion chip.
export function suspicionColor(score: number): string {
  if (score >= 60) return color.error.base;
  if (score >= 30) return color.warn.base;
  if (score >= 10) return color.accent.base;
  return color.success.base;
}

type Fetch =
  | { kind: "loading" }
  | { kind: "loaded"; report: SuspicionReport | null };

// ── P6 identity status (recruiter-only, informational) ──────────────────────
// Preferred source: the suspicion route's identity block (v2-aware server).
// Fallback: derive from the session's own identity.* event rows in the detail
// bundle — works the moment consent/verify events exist, even before the
// suspicion route learns to summarize them. Both absent (every v1 session,
// the entire dormant default) → null → no identity row renders at all.
function deriveIdentity(
  report: SuspicionReport | null,
  events: ReviewEvent[],
): SuspicionIdentity | null {
  if (report?.identity) return report.identity;
  let consent: SuspicionIdentity["consent"] = null;
  let verified: boolean | null = null;
  let matchConfidence: number | null = null;
  for (const e of events) {
    const p: Record<string, unknown> = e.payload ?? {};
    if (e.type === "identity.consent") {
      if (p["decision"] === "accepted" || p["decision"] === "declined") {
        consent = p["decision"];
      }
    } else if (e.type === "identity.verified") {
      if (typeof p["verified"] === "boolean") verified = p["verified"];
      const conf = p["match_confidence"] ?? p["matchConfidence"];
      if (typeof conf === "number") matchConfidence = conf;
    }
  }
  if (consent === null && verified === null && matchConfidence === null) return null;
  return { consent, verified, matchConfidence };
}

/** One-line recruiter-facing summary, e.g. "consented · verified (0.93)". */
function identitySummary(id: SuspicionIdentity): { text: string; tone: string } {
  if (id.consent === "declined") {
    return { text: "v2 declined — passive checks only", tone: color.text.secondary };
  }
  const consented = id.consent === "accepted" ? "consented" : "consent not recorded";
  if (id.verified === true) {
    const conf = id.matchConfidence !== null ? ` (${id.matchConfidence.toFixed(2)} confidence)` : "";
    return { text: `${consented} · identity verified${conf}`, tone: color.success.base };
  }
  if (id.verified === false) {
    const conf = id.matchConfidence !== null ? ` (${id.matchConfidence.toFixed(2)} confidence)` : "";
    return { text: `${consented} · identity NOT verified${conf}`, tone: color.warn.base };
  }
  return { text: `${consented} · identity not verified (not attempted)`, tone: color.text.secondary };
}

/** Location string from whatever geo fields exist; null when none do.
 *  Sessions recorded after the country-only mmdb swap have region/city null,
 *  so this typically renders just the country code — empty fields are
 *  filtered, never rendered as "null". */
function formatLocation(net: SuspicionNetwork): string | null {
  const parts = [net.city, net.region, net.country].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

export default function SuspicionPanel({ sessionId, events, sessionStart }: Props) {
  const [fetch, setFetch] = useState<Fetch>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setFetch({ kind: "loading" });
    void getSuspicionReport(sessionId).then((report) => {
      if (!cancelled) setFetch({ kind: "loaded", report });
    });
    return () => { cancelled = true; };
  }, [sessionId]);

  if (fetch.kind === "loading") return null;
  const report = fetch.report;

  // Timeline source: the suspicion route's seq-ordered integrity events are
  // authoritative; fall back to filtering the detail bundle's events when the
  // route is absent (older server) but integrity rows already exist.
  const integrityEvents: IntegrityTimelineEvent[] =
    report !== null
      ? report.events
      // P6: identity.* rows (consent / verification) belong on this timeline
      // too — same informational channel as integrity.*.
      : events.filter((e) => e.type.startsWith("integrity.") || e.type.startsWith("identity."));

  const identity = deriveIdentity(report, events);
  const network = report?.network ?? null;

  // Older server deploy (no route) and nothing recorded → stay invisible.
  if (report === null && integrityEvents.length === 0 && identity === null) return null;

  const score = report !== null ? Math.max(0, Math.min(100, Math.round(report.score))) : null;
  const factors = report?.factors ?? [];
  const startMs = new Date(sessionStart).getTime();

  // Detector v4 (operator decision 2026-07-09): copy/paste events no longer
  // contribute to the score — too noisy — so they arrive with no factor row.
  // The counts stay recruiter-visible: derived here from the raw integrity
  // event stream and rendered alongside the factor table, labeled "not
  // scored". (Rows also cover pre-v4 servers whose factors still include
  // paste_burst/copy_source — those keep rendering as scored factors above.)
  const scoredKinds = new Set(factors.map((f) => f.kind));
  const notScored = [
    { kind: "paste_burst", count: integrityEvents.filter((e) => e.type === "integrity.paste_burst").length },
    { kind: "copy", count: integrityEvents.filter((e) => e.type === "integrity.copy").length },
  ].filter((r) => r.count > 0 && !scoredKinds.has(r.kind) && !scoredKinds.has(`${r.kind}_source`));

  return (
    <section
      style={{
        background: color.bg.panel,
        border: `1px solid ${color.border.default}`,
        borderRadius: radius.md,
        marginBottom: 16,
        overflow: "hidden",
      }}
    >
      <header
        style={{
          padding: "10px 16px",
          background: color.bg.elevated,
          borderBottom: `1px solid ${color.border.default}`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          // The badge must never truncate in the narrow right rail — let the
          // header wrap onto a second line instead.
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: color.text.secondary, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Proctoring
        </span>
        <span
          style={{
            fontSize: 10,
            fontFamily: font.mono,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: color.warn.base,
            border: `1px solid ${color.warn.base}`,
            borderRadius: radius.sm,
            padding: "2px 8px",
            lineHeight: 1.5,
          }}
        >
          integrity signal — informational, not scored
        </span>
      </header>

      {/* Score */}
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${color.border.subtle}`, display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontSize: 12, color: color.text.secondary }}>Suspicion Score</span>
        <span
          style={{
            fontSize: 26,
            fontWeight: 700,
            fontFamily: font.mono,
            fontVariantNumeric: "tabular-nums",
            color: score !== null ? suspicionColor(score) : color.text.muted,
          }}
        >
          {score !== null ? score : "—"}
        </span>
        <span style={{ fontSize: 12, color: color.text.muted }}>/ 100</span>
        {report !== null && (
          <span style={{ fontSize: 10, color: color.text.muted, fontFamily: font.mono, marginLeft: "auto" }}>
            detector v{report.version}
          </span>
        )}
      </div>

      {/* P6 identity status (proctoring v2) — renders only when a consent /
          verification signal exists; invisible for every v1 session. Same
          rule as everything in this panel: informational, never scored. */}
      {identity !== null && (
        <div style={{ padding: "10px 16px", borderBottom: `1px solid ${color.border.subtle}`, display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontSize: 12, color: color.text.secondary }}>Identity</span>
          <span style={{ fontSize: 12, fontFamily: font.mono, color: identitySummary(identity).tone }}>
            {identitySummary(identity).text}
          </span>
        </div>
      )}

      {/* Geo/network row group (geo/network slice) — renders only when the
          server reports a network block (sessions recorded after the slice).
          Derived values only (coarse geo, counts, a boolean — never an IP);
          informational like everything in this panel, never scored. */}
      {network !== null && (
        <div style={{ padding: "10px 16px", borderBottom: `1px solid ${color.border.subtle}` }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: color.text.secondary }}>Network</span>
            <span style={{ fontSize: 10, color: color.text.muted, fontFamily: font.mono, marginLeft: "auto" }}>
              informational — not scored
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 14, rowGap: 4, fontSize: 11 }}>
            <span style={netLabel}>location at start</span>
            <span style={netValue}>{formatLocation(network) ?? "unknown"}</span>
            <span style={netLabel}>IP changes</span>
            <span style={{ ...netValue, color: network.ipChanges > 0 ? color.warn.base : color.text.secondary }}>
              {network.ipChanges}
            </span>
            <span style={netLabel}>countries seen</span>
            <span style={{ ...netValue, color: network.countries.length > 1 ? color.warn.base : color.text.secondary }}>
              {network.countries.length > 0 ? network.countries.join(", ") : "unknown"}
            </span>
            <span style={netLabel}>timezone mismatch</span>
            <span style={{ ...netValue, color: network.tzMismatch ? color.warn.base : color.text.secondary }}>
              {network.tzMismatch ? "yes — browser timezone contradicts IP country" : "no"}
            </span>
          </div>
        </div>
      )}

      {/* Factor breakdown — scored factors first, then the v4 informational
          copy/paste counts (visible, counted, never contributing points). */}
      {(factors.length > 0 || notScored.length > 0) && (
        <div style={{ borderBottom: `1px solid ${color.border.subtle}` }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ background: color.bg.input }}>
                <th style={th}>Factor</th>
                <th style={{ ...th, textAlign: "right" }}>Count</th>
                <th style={{ ...th, textAlign: "right" }}>Contribution</th>
              </tr>
            </thead>
            <tbody>
              {factors.map((f) => (
                <tr key={f.kind} style={{ borderBottom: `1px solid ${color.border.subtle}` }}>
                  <td style={td}>{f.kind}</td>
                  <td style={{ ...td, textAlign: "right" }}>{f.count}</td>
                  <td style={{ ...td, textAlign: "right", color: color.text.primary }}>
                    +{Number(f.contribution).toFixed(1)}
                  </td>
                </tr>
              ))}
              {notScored.map((f) => (
                <tr key={f.kind} style={{ borderBottom: `1px solid ${color.border.subtle}` }}>
                  <td style={td}>{f.kind}</td>
                  <td style={{ ...td, textAlign: "right" }}>{f.count}</td>
                  <td style={{ ...td, textAlign: "right", color: color.text.muted, fontStyle: "italic" }}>
                    not scored
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Integrity-event mini-timeline (same visual language as Timeline) */}
      <div style={{ maxHeight: 280, overflowY: "auto" }}>
        {integrityEvents.length === 0 ? (
          <div style={{ padding: 16, color: color.text.muted, fontSize: 12, textAlign: "center" }}>
            No integrity events recorded
          </div>
        ) : (
          integrityEvents.map((ev) => {
            const tMs = new Date(ev.ts).getTime() - startMs;
            return (
              <div
                key={ev.seq}
                style={{
                  padding: "6px 16px",
                  borderBottom: `1px solid ${color.border.subtle}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <span style={{ width: 4, height: 4, borderRadius: 2, background: color.warn.base, flexShrink: 0 }} />
                <span style={{ fontFamily: font.mono, fontSize: 10, color: color.text.muted, width: 36, flexShrink: 0 }}>
                  {formatRelativeMs(tMs)}
                </span>
                <span style={{ fontFamily: font.mono, fontSize: 10, color: color.text.muted, width: 34, flexShrink: 0 }}>
                  #{ev.seq}
                </span>
                <span style={{ fontSize: 12, color: color.text.primary }}>
                  {ev.type.replace(/^(integrity|identity)\./, "")}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: color.text.muted,
                    fontFamily: font.mono,
                    marginLeft: "auto",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: 180,
                  }}
                  title={JSON.stringify(ev.payload ?? {})}
                >
                  {summarizePayload(ev.payload ?? {})}
                </span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

/** Compact one-line payload summary, e.g. "chars=1204 target=editor". */
function summarizePayload(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 12px",
  fontSize: 10,
  fontWeight: 600,
  color: color.text.secondary,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  borderBottom: `1px solid ${color.border.default}`,
};

const td: React.CSSProperties = {
  padding: "6px 12px",
  color: color.text.secondary,
  fontFamily: font.mono,
  fontVariantNumeric: "tabular-nums",
  fontSize: 11,
};

const netLabel: React.CSSProperties = {
  color: color.text.muted,
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  alignSelf: "baseline",
};

const netValue: React.CSSProperties = {
  fontFamily: font.mono,
  fontVariantNumeric: "tabular-nums",
  color: color.text.secondary,
};
