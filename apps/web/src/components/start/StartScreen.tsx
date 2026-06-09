"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createSession,
  getScenarioBySlug,
  ScenarioNotFoundError,
  type Scenario,
} from "@/lib/api";

interface Props {
  slug: string;
}

type Phase =
  | { kind: "loading" }
  | { kind: "not-found" }
  | { kind: "error"; message: string }
  | { kind: "ready"; scenario: Scenario }
  | { kind: "starting"; scenario: Scenario }
  | { kind: "starting-failed"; scenario: Scenario; message: string };

const BG       = "#1e1e1e";
const PANEL    = "#252526";
const BORDER   = "#404040";
const TEXT     = "#cccccc";
const MUTED    = "#858585";
const WHITE    = "#ffffff";
const PRIMARY  = "#0e639c";
const PRIMARY_HOVER = "#1177bb";
const ERROR    = "#f48771";
const WARN     = "#dcb67a";
const FONT     = "'Segoe UI', system-ui, -apple-system, sans-serif";

function fmtBytes(mb: number | null): string {
  if (mb === null) return "—";
  if (mb >= 1024) return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GiB`;
  return `${mb} MiB`;
}

function fmtNum(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString("en-US");
}

export default function StartScreen({ slug }: Props) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: "loading" });
    getScenarioBySlug(slug)
      .then((scenario) => {
        if (!cancelled) setPhase({ kind: "ready", scenario });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ScenarioNotFoundError) {
          setPhase({ kind: "not-found" });
        } else {
          const message = err instanceof Error ? err.message : "Failed to load assessment";
          setPhase({ kind: "error", message });
        }
      });
    return () => { cancelled = true; };
  }, [slug]);

  async function begin(scenario: Scenario): Promise<void> {
    setPhase({ kind: "starting", scenario });
    try {
      const { sessionId } = await createSession({ scenarioId: scenario.id });
      router.push(`/session/${sessionId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start the session";
      setPhase({ kind: "starting-failed", scenario, message });
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: BG,
        color: TEXT,
        fontFamily: FONT,
        display: "flex",
        justifyContent: "center",
        padding: "48px 24px 64px",
      }}
    >
      <div style={{ width: "100%", maxWidth: 720 }}>
        <header style={{ marginBottom: 32 }}>
          <div
            style={{
              fontSize: 11,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: MUTED,
              fontWeight: 600,
            }}
          >
            Crucible
          </div>
        </header>

        {phase.kind === "loading" && (
          <p style={{ color: MUTED, fontSize: 14 }}>Loading assessment…</p>
        )}

        {phase.kind === "not-found" && (
          <NotFoundCard />
        )}

        {phase.kind === "error" && (
          <ErrorCard
            message={phase.message}
            onRetry={() => setPhase({ kind: "loading" })}
          />
        )}

        {(phase.kind === "ready" || phase.kind === "starting" || phase.kind === "starting-failed") && (
          <ScenarioCard
            scenario={phase.scenario}
            starting={phase.kind === "starting"}
            beginError={phase.kind === "starting-failed" ? phase.message : null}
            onBegin={() => { void begin(phase.scenario); }}
          />
        )}
      </div>
    </main>
  );
}

function NotFoundCard() {
  return (
    <div
      style={{
        background: PANEL,
        border: `1px solid ${BORDER}`,
        borderRadius: 6,
        padding: "32px 28px",
      }}
    >
      <h1 style={{ fontSize: 22, color: WHITE, margin: 0, marginBottom: 12, fontWeight: 600 }}>
        Assessment not found
      </h1>
      <p style={{ color: MUTED, fontSize: 14, lineHeight: 1.5, margin: 0 }}>
        The link may be expired or incorrect. Contact the recruiter who sent
        you the link.
      </p>
    </div>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      style={{
        background: PANEL,
        border: `1px solid ${BORDER}`,
        borderRadius: 6,
        padding: "28px 24px",
      }}
    >
      <h1 style={{ fontSize: 18, color: WHITE, margin: 0, marginBottom: 8, fontWeight: 600 }}>
        Couldn&apos;t load the assessment
      </h1>
      <p style={{ color: ERROR, fontSize: 13, margin: 0, marginBottom: 16, lineHeight: 1.4 }}>
        {message}
      </p>
      <button onClick={onRetry} style={primaryButtonStyle(false)}>
        Retry
      </button>
    </div>
  );
}

function ScenarioCard({
  scenario, starting, beginError, onBegin,
}: {
  scenario: Scenario;
  starting: boolean;
  beginError: string | null;
  onBegin: () => void;
}) {
  const c = scenario.constraints;
  return (
    <div>
      {/* Title block */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 24,
        }}
      >
        <h1 style={{ fontSize: 26, color: WHITE, margin: 0, fontWeight: 600, letterSpacing: "-0.3px" }}>
          {scenario.title}
        </h1>
        <RoleDifficultyPill role={scenario.role} difficulty={scenario.difficulty} />
      </div>

      {/* Brief */}
      {scenario.brief && (
        <section
          style={{
            background: PANEL,
            border: `1px solid ${BORDER}`,
            borderRadius: 6,
            padding: "20px 22px",
            marginBottom: 28,
          }}
        >
          <SectionHeader>The situation</SectionHeader>
          <p
            style={{
              color: TEXT,
              fontSize: 14,
              lineHeight: 1.6,
              margin: 0,
              marginTop: 10,
              whiteSpace: "pre-wrap",
            }}
          >
            {scenario.brief}
          </p>
        </section>
      )}

      {/* How this works */}
      <section style={{ marginBottom: 28 }}>
        <SectionHeader>How this works</SectionHeader>
        <ul
          style={{
            color: TEXT,
            fontSize: 14,
            lineHeight: 1.6,
            margin: 0,
            marginTop: 10,
            paddingLeft: 20,
          }}
        >
          <li>
            You&apos;ll work in a sandboxed dev environment with files, a
            terminal, a SQL data explorer, and a deliverable panel for your
            final answer.
          </li>
          <li>
            Your client and a teammate will reach you in the{" "}
            <strong>Messages</strong> tab — sometimes unprompted. Reply when
            you have something to say.
          </li>
          <li>
            The <strong>Assistant</strong> tab is an AI helper. Token usage
            counts against your budget, so use it where it pays off.
          </li>
          <li>
            The session is timed. The <strong>Time</strong> indicator at the
            top of the workspace counts down. Submit your deliverable before
            time runs out — you can iterate.
          </li>
          <li>
            When the session ends, your work is automatically captured for
            review.
          </li>
        </ul>
      </section>

      {/* Constraints */}
      <section style={{ marginBottom: 28 }}>
        <SectionHeader>Your constraints</SectionHeader>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(5, 1fr)",
            gap: 10,
            marginTop: 10,
          }}
        >
          <ConstraintCell label="Time"    value={c.time_minutes !== null ? `${c.time_minutes} min` : "—"} />
          <ConstraintCell label="Tokens"  value={fmtNum(c.tokens)} />
          <ConstraintCell label="Compute" value={c.compute_minutes !== null ? `${c.compute_minutes} min` : "—"} />
          <ConstraintCell label="Money"   value={c.money_usd !== null ? `$${c.money_usd}` : "—"} />
          <ConstraintCell label="Memory"  value={fmtBytes(c.memory_mb)} />
        </div>
      </section>

      {/* Deliverable */}
      {scenario.deliverable_components.length > 0 && (
        <section style={{ marginBottom: 32 }}>
          <SectionHeader>Your deliverable</SectionHeader>
          <p style={{ color: MUTED, fontSize: 13, margin: 0, marginTop: 8, marginBottom: 12 }}>
            Submit when you&apos;re confident — drafts are allowed and the
            latest version wins.
          </p>
          <ul
            style={{
              color: TEXT,
              fontSize: 13,
              lineHeight: 1.55,
              margin: 0,
              paddingLeft: 20,
            }}
          >
            {scenario.deliverable_components.map((d) => (
              <li key={d.key} style={{ marginBottom: 4 }}>
                <strong style={{ color: WHITE }}>{d.label}</strong>
                {d.what ? <> — {d.what}</> : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Begin */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
        <button
          onClick={onBegin}
          disabled={starting}
          style={primaryButtonStyle(starting)}
          onMouseEnter={(e) => {
            if (!starting) (e.currentTarget as HTMLButtonElement).style.background = PRIMARY_HOVER;
          }}
          onMouseLeave={(e) => {
            if (!starting) (e.currentTarget as HTMLButtonElement).style.background = PRIMARY;
          }}
        >
          {starting ? "Starting…" : "Begin assessment"}
        </button>
        <p style={{ color: MUTED, fontSize: 12, margin: 0, lineHeight: 1.5 }}>
          Once you click Begin, the timer starts and the sandbox is
          provisioned. Allow ~5 seconds for the workspace to load.
        </p>
        {beginError && (
          <p style={{ color: ERROR, fontSize: 13, margin: 0 }}>{beginError}</p>
        )}
      </div>
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

function ConstraintCell({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: PANEL,
        border: `1px solid ${BORDER}`,
        borderRadius: 4,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: MUTED,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "'SF Mono', Menlo, Consolas, monospace",
          fontSize: 14,
          color: WHITE,
          fontWeight: 500,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function RoleDifficultyPill({ role, difficulty }: { role: string; difficulty: string | null }) {
  const color = difficulty === "mid" ? WARN : MUTED;
  const text  = difficulty ? `${role} · ${difficulty}` : role;
  return (
    <span
      style={{
        fontSize: 11,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color,
        border: `1px solid ${color}`,
        borderRadius: 999,
        padding: "3px 10px",
        fontWeight: 600,
        flexShrink: 0,
        marginTop: 4,
      }}
    >
      {text}
    </span>
  );
}

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? "#37373d" : PRIMARY,
    color: WHITE,
    border: "none",
    padding: "12px 32px",
    fontSize: 14,
    fontWeight: 500,
    fontFamily: FONT,
    borderRadius: 4,
    cursor: disabled ? "not-allowed" : "pointer",
    transition: "background 0.15s",
  };
}
