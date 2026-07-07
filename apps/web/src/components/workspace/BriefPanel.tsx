"use client";
import { useSessionStore } from "@/stores/sessionStore";
import { color, font } from "@/styles/tokens";
import SectionLabel from "@/components/ui/SectionLabel";
import Stat from "@/components/ui/Stat";
import Pill from "@/components/ui/Pill";

function fmtBytes(mb: number | null): string {
  if (mb === null) return "—";
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GiB`;
  return `${mb} MiB`;
}
function fmtNum(n: number | null): string {
  return n === null ? "—" : n.toLocaleString("en-US");
}

/** Persistent brief reference inside the workspace. Read-only — the
 *  ConstraintHUD in the top chrome owns live balances; this panel is the
 *  static "what am I doing again?" card the candidate can re-open any time. */
export default function BriefPanel() {
  const scenario = useSessionStore((s) => s.scenario);
  const c = useSessionStore((s) => s.scenarioConstraints);

  if (!scenario.title && !scenario.brief && !c) {
    return (
      <div style={{ padding: 24, color: color.text.muted, fontSize: 13, fontFamily: font.sans }}>
        No scenario bound to this session.
      </div>
    );
  }

  return (
    <div
      style={{
        height: "100%",
        overflowY: "auto",
        background: color.bg.page,
        color: color.text.primary,
        fontFamily: font.sans,
        padding: "20px 22px",
      }}
    >
      {scenario.title && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
          <h2 style={{ margin: 0, color: color.text.primary, fontSize: 18, fontWeight: 600, letterSpacing: "-0.2px" }}>
            {scenario.title}
          </h2>
          {(scenario.role || scenario.difficulty) && (
            <Pill tone={scenario.difficulty === "mid" ? "warn" : "neutral"}>
              {[scenario.role, scenario.difficulty].filter(Boolean).join(" · ")}
            </Pill>
          )}
        </div>
      )}

      {scenario.brief && (
        <section style={{ marginBottom: 24 }}>
          <SectionLabel>The situation</SectionLabel>
          <p
            style={{
              fontSize: 13,
              lineHeight: 1.65,
              color: color.text.primary,
              margin: 0,
              marginTop: 10,
              whiteSpace: "pre-wrap",
            }}
          >
            {scenario.brief}
          </p>
        </section>
      )}

      {c && (
        <section>
          <SectionLabel>Constraints (starting values)</SectionLabel>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
              marginTop: 10,
            }}
          >
            <CardCell label="Time"    value={c.time_minutes !== null ? `${c.time_minutes} min` : "—"} />
            <CardCell label="Tokens"  value={fmtNum(c.tokens)} />
            <CardCell label="Compute" value={c.compute_minutes !== null ? `${c.compute_minutes} min` : "—"} />
            <CardCell label="Money"   value={c.money_usd !== null ? `$${c.money_usd}` : "—"} />
            <CardCell label="Memory"  value={fmtBytes(c.memory_mb)} />
          </div>
          <p style={{ color: color.text.muted, fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>
            Live remaining balances are shown in the top bar.
          </p>
        </section>
      )}
    </div>
  );
}

function CardCell({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: color.bg.panel,
        border: `1px solid ${color.border.subtle}`,
        borderRadius: 6,
        padding: "10px 12px",
      }}
    >
      <Stat label={label} value={value} size="sm" />
    </div>
  );
}
