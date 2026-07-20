"use client";
import { useEffect, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { listScenarioDocs } from "@/lib/api";
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
  const sessionId = useSessionStore((s) => s.sessionId);

  // Doc titles for the "What you have" inventory — best-effort; the section
  // simply omits the row until (or unless) the list resolves.
  const [docTitles, setDocTitles] = useState<string[]>([]);
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    listScenarioDocs(sessionId)
      .then((docs) => { if (!cancelled) setDocTitles(docs.map((d) => d.title)); })
      .catch(() => { /* tolerate — inventory renders without doc titles */ });
    return () => { cancelled = true; };
  }, [sessionId]);

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
          <SectionLabel tone="section">The situation</SectionLabel>
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

      {/* "What you have" inventory — the anti-treasure-hunt map. Everything
          here is environment mechanics, no scenario content. */}
      <section style={{ marginBottom: 24 }}>
        <SectionLabel tone="section">What you have</SectionLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
          <InventoryRow
            icon="▤"
            title={scenario.datasetKind === "git_repo" ? "Codebase" : "Data"}
            body={
              scenario.datasetKind === "git_repo"
                ? "The inherited service repo in the Files pane (writable) — source, tests, docs, and its data/ files. Run it and its tests in the Terminal. README.md has the full map."
                : scenario.datasetTables && scenario.datasetTables.length > 0
                ? `customer.db (read-only) — tables: ${scenario.datasetTables.join(", ")}. Query it in the Data tab or the Terminal.`
                : "Your workspace files, in the Files pane. There's a README.md with the full map."
            }
          />
          {docTitles.length > 0 && (
            <InventoryRow
              icon="≡"
              title="Documents"
              body={`${docTitles.map((t) => `“${t}”`).join(", ")} — in the Docs tab.`}
            />
          )}
          {(scenario.clientPersona || scenario.teamPersona) && (
            <InventoryRow
              icon="◉"
              title="People"
              body={[
                scenario.clientPersona
                  ? `${scenario.clientPersona.name} (${scenario.clientPersona.role} — your client)`
                  : null,
                scenario.teamPersona
                  ? `${scenario.teamPersona.name} (${scenario.teamPersona.role} — your teammate)`
                  : null,
              ]
                .filter(Boolean)
                .join(" and ") + " — both in the Messages tab, one shared channel."}
            />
          )}
          <InventoryRow
            icon="▣"
            title="Deliverable"
            body="The Deliverable tab lists exactly what to submit — check it early so you know what you're working toward."
          />
          <InventoryRow
            icon="✦"
            title="Assistant"
            body="An AI helper in the Assistant tab. It spends your session token budget — use it deliberately."
          />
        </div>
      </section>

      {c && (
        <section>
          <SectionLabel tone="section">Constraints (starting values)</SectionLabel>
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

function InventoryRow({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        background: color.bg.panel,
        border: `1px solid ${color.border.subtle}`,
        borderRadius: 6,
        padding: "10px 12px",
      }}
    >
      <span aria-hidden="true" style={{ color: color.accent.base, fontSize: 13, lineHeight: 1.5, flexShrink: 0 }}>
        {icon}
      </span>
      <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>
        <span style={{ color: color.text.primary, fontWeight: 600 }}>{title}: </span>
        <span style={{ color: color.text.secondary }}>{body}</span>
      </div>
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
