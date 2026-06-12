"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createSession, getScenarioBySlug, ScenarioNotFoundError, type Scenario,
} from "@/lib/api";
import { color, radius } from "@/styles/tokens";
import Card from "@/components/ui/Card";
import Pill from "@/components/ui/Pill";
import Button from "@/components/ui/Button";
import SectionLabel from "@/components/ui/SectionLabel";
import Stat from "@/components/ui/Stat";

interface Props { slug: string; }

type Phase =
  | { kind: "loading" }
  | { kind: "not-found" }
  | { kind: "error"; message: string }
  | { kind: "ready"; scenario: Scenario }
  | { kind: "starting"; scenario: Scenario }
  | { kind: "starting-failed"; scenario: Scenario; message: string };

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
  const [inviteCode, setInviteCode] = useState("");

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
      const trimmedCode = inviteCode.trim();
      const { sessionId } = await createSession({
        scenarioId: scenario.id,
        ...(trimmedCode ? { inviteCode: trimmedCode } : {}),
      });
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
        background: color.bg.page,
        color: color.text.primary,
        display: "flex",
        justifyContent: "center",
        overflowY: "auto",
        padding: "56px 24px 80px",
      }}
    >
      <div style={{ width: "100%", maxWidth: 760 }}>
        <header style={{
          marginBottom: 40,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <Wordmark />
        </header>

        {phase.kind === "loading" && (
          <div style={{ color: color.text.muted, fontSize: 14 }}>Loading assessment…</div>
        )}

        {phase.kind === "not-found" && (
          <Card padding={6}>
            <div style={{ fontSize: 22, color: color.text.primary, fontWeight: 600, marginBottom: 10 }}>
              Assessment not found
            </div>
            <div style={{ color: color.text.secondary, fontSize: 14, lineHeight: 1.6 }}>
              The link may be expired or incorrect. Contact the recruiter who sent you the link.
            </div>
          </Card>
        )}

        {phase.kind === "error" && (
          <Card padding={5}>
            <SectionLabel>Couldn&apos;t load the assessment</SectionLabel>
            <div style={{ color: color.error.base, fontSize: 13, marginTop: 8, marginBottom: 14, lineHeight: 1.5 }}>
              {phase.message}
            </div>
            <Button variant="primary" size="md" onClick={() => setPhase({ kind: "loading" })}>Retry</Button>
          </Card>
        )}

        {(phase.kind === "ready" || phase.kind === "starting" || phase.kind === "starting-failed") && (
          <ScenarioBody
            scenario={phase.scenario}
            starting={phase.kind === "starting"}
            beginError={phase.kind === "starting-failed" ? phase.message : null}
            inviteCode={inviteCode}
            onInviteCodeChange={setInviteCode}
            onBegin={() => { void begin(phase.scenario); }}
          />
        )}
      </div>
    </main>
  );
}

function Wordmark() {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
    }}>
      <div style={{
        width: 22, height: 22, borderRadius: radius.sm,
        background: `linear-gradient(135deg, ${color.accent.base} 0%, ${color.persona.assistant} 100%)`,
        display: "flex", alignItems: "center", justifyContent: "center",
        color: "#fff", fontWeight: 700, fontSize: 12, letterSpacing: "-0.5px",
      }}>
        C
      </div>
      <div style={{
        fontSize: 12, fontWeight: 600, letterSpacing: "0.16em",
        color: color.text.secondary, textTransform: "uppercase",
      }}>
        Crucible
      </div>
    </div>
  );
}

function ScenarioBody({
  scenario, starting, beginError, inviteCode, onInviteCodeChange, onBegin,
}: {
  scenario: Scenario;
  starting: boolean;
  beginError: string | null;
  inviteCode: string;
  onInviteCodeChange: (v: string) => void;
  onBegin: () => void;
}) {
  const c = scenario.constraints;
  return (
    <div>
      <div style={{
        display: "flex", alignItems: "flex-start", justifyContent: "space-between",
        gap: 16, marginBottom: 28,
      }}>
        <h1 style={{
          fontSize: 28, color: color.text.primary,
          margin: 0, fontWeight: 600, letterSpacing: "-0.4px",
          lineHeight: 1.2,
        }}>
          {scenario.title}
        </h1>
        <div style={{ marginTop: 4 }}>
          <Pill tone={scenario.difficulty === "mid" ? "warn" : "neutral"} size="md">
            {[scenario.role, scenario.difficulty].filter(Boolean).join(" · ")}
          </Pill>
        </div>
      </div>

      {scenario.brief && (
        <Card header="The situation" padding={5} style={{ marginBottom: 28 }}>
          <p style={{
            color: color.text.primary,
            fontSize: 14, lineHeight: 1.7, margin: 0,
            whiteSpace: "pre-wrap",
          }}>
            {scenario.brief}
          </p>
        </Card>
      )}

      <section style={{ marginBottom: 28 }}>
        <SectionLabel>How this works</SectionLabel>
        <ul style={{
          color: color.text.primary,
          fontSize: 14, lineHeight: 1.7,
          margin: 0, marginTop: 12, paddingLeft: 20,
        }}>
          <li style={{ marginBottom: 4 }}>
            You&apos;ll work in a sandboxed dev environment with files, a
            terminal, a SQL data explorer, and a deliverable panel.
          </li>
          <li style={{ marginBottom: 4 }}>
            Your client and a teammate will reach you in the{" "}
            <strong style={{ color: color.text.primary }}>Messages</strong>{" "}
            tab — sometimes unprompted. Reply when you have something to say.
          </li>
          <li style={{ marginBottom: 4 }}>
            The <strong style={{ color: color.text.primary }}>Assistant</strong>{" "}
            tab is an AI helper. Token usage counts against your budget.
          </li>
          <li style={{ marginBottom: 4 }}>
            The session is timed. The Time indicator at the top counts down.
            Submit your deliverable before time runs out — you can iterate.
          </li>
          <li>
            When the session ends, your work is automatically captured for
            review.
          </li>
        </ul>
      </section>

      <section style={{ marginBottom: 28 }}>
        <SectionLabel>Your constraints</SectionLabel>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: 10,
          marginTop: 12,
        }}>
          <ConstraintCell label="Time"    value={c.time_minutes !== null ? `${c.time_minutes}m` : "—"} />
          <ConstraintCell label="Tokens"  value={fmtNum(c.tokens)} />
          <ConstraintCell label="Compute" value={c.compute_minutes !== null ? `${c.compute_minutes}m` : "—"} />
          <ConstraintCell label="Money"   value={c.money_usd !== null ? `$${c.money_usd}` : "—"} />
          <ConstraintCell label="Memory"  value={fmtBytes(c.memory_mb)} />
        </div>
      </section>

      {scenario.deliverable_components.length > 0 && (
        <section style={{ marginBottom: 32 }}>
          <SectionLabel>Your deliverable</SectionLabel>
          <div style={{ color: color.text.secondary, fontSize: 12, marginTop: 8, marginBottom: 14, lineHeight: 1.6 }}>
            Submit when you&apos;re confident — drafts are allowed and the latest version wins.
          </div>
          <ul style={{
            color: color.text.primary,
            fontSize: 13, lineHeight: 1.6,
            margin: 0, paddingLeft: 20,
          }}>
            {scenario.deliverable_components.map((d) => (
              <li key={d.key} style={{ marginBottom: 6 }}>
                <strong style={{ color: color.text.primary, fontWeight: 600 }}>{d.label}</strong>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div style={{
        display: "flex", flexDirection: "column",
        alignItems: "flex-start", gap: 14,
        paddingTop: 4,
      }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 12, color: color.text.muted }}>Invite code</span>
          <input
            type="text"
            value={inviteCode}
            onChange={(e) => onInviteCodeChange(e.target.value)}
            disabled={starting}
            placeholder="Paste the code from your invite"
            autoComplete="off"
            spellCheck={false}
            style={{
              width: 280,
              background: color.bg.elevated,
              border: `1px solid ${color.border.default}`,
              borderRadius: radius.sm,
              color: color.text.primary,
              fontSize: 13,
              padding: "8px 10px",
              outline: "none",
              fontFamily: "inherit",
            }}
          />
        </label>
        <Button variant="primary" size="lg" disabled={starting} onClick={onBegin}>
          {starting ? "Starting…" : "Begin assessment"}
        </Button>
        <p style={{ color: color.text.muted, fontSize: 12, margin: 0, lineHeight: 1.6 }}>
          Once you click Begin, the timer starts and the sandbox is provisioned.
          Allow ~5 seconds for the workspace to load.
        </p>
        {beginError && (
          <p style={{ color: color.error.base, fontSize: 13, margin: 0 }}>{beginError}</p>
        )}
      </div>
    </div>
  );
}

function ConstraintCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      background: color.bg.panel,
      border: `1px solid ${color.border.subtle}`,
      borderRadius: radius.md,
      padding: "12px 14px",
      display: "flex", flexDirection: "column", gap: 4,
    }}>
      <Stat label={label} value={value} size="md" />
    </div>
  );
}
