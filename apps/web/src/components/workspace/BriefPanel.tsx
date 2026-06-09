"use client";
import { useSessionStore } from "@/stores/sessionStore";

const PANEL  = "#252526";
const BORDER = "#404040";
const TEXT   = "#cccccc";
const MUTED  = "#858585";
const WHITE  = "#ffffff";

function fmtBytes(mb: number | null): string {
  if (mb === null) return "—";
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GiB`;
  return `${mb} MiB`;
}

function fmtNum(n: number | null): string {
  return n === null ? "—" : n.toLocaleString("en-US");
}

/** Persistent brief reference inside the workspace. Read-only — the
 *  ConstraintHUD already owns live balances; this panel is the static
 *  "what am I doing again?" card the candidate can re-open any time. */
export default function BriefPanel() {
  const { scenario, scenarioConstraints } = useSessionStore();
  const c = scenarioConstraints;

  if (!scenario.title && !scenario.brief && !c) {
    return (
      <div
        style={{
          padding: 24,
          color: MUTED,
          fontSize: 13,
          fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
        }}
      >
        No scenario bound to this session.
      </div>
    );
  }

  return (
    <div
      style={{
        height: "100%",
        overflowY: "auto",
        background: "#1e1e1e",
        color: TEXT,
        fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
        padding: "20px 22px",
      }}
    >
      {scenario.title && (
        <h2 style={{ margin: 0, marginBottom: 6, color: WHITE, fontSize: 16, fontWeight: 600 }}>
          {scenario.title}
        </h2>
      )}
      {(scenario.role || scenario.difficulty) && (
        <div
          style={{
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: MUTED,
            marginBottom: 18,
          }}
        >
          {[scenario.role, scenario.difficulty].filter(Boolean).join(" · ")}
        </div>
      )}

      {scenario.brief && (
        <section style={{ marginBottom: 20 }}>
          <SectionHeader>The situation</SectionHeader>
          <p style={{ fontSize: 13, lineHeight: 1.6, color: TEXT, margin: 0, marginTop: 8, whiteSpace: "pre-wrap" }}>
            {scenario.brief}
          </p>
        </section>
      )}

      {c && (
        <section>
          <SectionHeader>Your constraints (starting values)</SectionHeader>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
              marginTop: 8,
            }}
          >
            <Cell label="Time"    value={c.time_minutes !== null ? `${c.time_minutes} min` : "—"} />
            <Cell label="Tokens"  value={fmtNum(c.tokens)} />
            <Cell label="Compute" value={c.compute_minutes !== null ? `${c.compute_minutes} min` : "—"} />
            <Cell label="Money"   value={c.money_usd !== null ? `$${c.money_usd}` : "—"} />
            <Cell label="Memory"  value={fmtBytes(c.memory_mb)} />
          </div>
          <p style={{ color: MUTED, fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>
            Live remaining balances are shown in the top bar.
          </p>
        </section>
      )}
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: MUTED,
        fontWeight: 600,
      }}
    >
      {children}
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: PANEL,
        border: `1px solid ${BORDER}`,
        borderRadius: 4,
        padding: "8px 10px",
      }}
    >
      <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: MUTED }}>
        {label}
      </div>
      <div
        style={{
          fontFamily: "'SF Mono', Menlo, Consolas, monospace",
          fontSize: 13,
          color: WHITE,
          fontWeight: 500,
          marginTop: 2,
        }}
      >
        {value}
      </div>
    </div>
  );
}
