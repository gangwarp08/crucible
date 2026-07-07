"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createSession, getScenarioBySlug,
  storeInviteCode, getStoredInviteCode,
  ScenarioNotFoundError, ScenarioInviteRequiredError,
  type Scenario,
} from "@/lib/api";
import { color, radius, font } from "@/styles/tokens";
import Card from "@/components/ui/Card";
import Pill from "@/components/ui/Pill";
import Button from "@/components/ui/Button";
import SectionLabel from "@/components/ui/SectionLabel";
import Stat from "@/components/ui/Stat";
import Wordmark from "@/components/ui/Wordmark";

interface Props {
  slug: string;
  /** RD6/P5.1 single-use session link token from ?link=… (read server-side in
   *  app/start/[slug]/page.tsx). null when the candidate arrived without one. */
  linkToken?: string | null;
}

type Phase =
  | { kind: "loading" }
  | { kind: "not-found" }
  | { kind: "error"; message: string }
  // Server returned 401 — INVITE_CODE is set and the probe was un-coded.
  // Candidate is shown the invite prompt. `inviteError` carries the failed-
  // submit message; `submitting` is true while the refetch is in flight.
  | { kind: "invite-required"; inviteError: string | null; submitting: boolean }
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

export default function StartScreen({ slug, linkToken }: Props) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [inviteCode, setInviteCode] = useState("");
  // Invite code the candidate already used to unlock the scenario. Reused on
  // Begin so we don't ask twice. null when the server isn't gating.
  const [validatedInviteCode, setValidatedInviteCode] = useState<string | null>(null);

  // Probe the server for the scenario, reusing any invite code already
  // validated this tab (e.g. on the catalog page) so the candidate isn't
  // asked twice. Two outcomes:
  //   - 200 → server not gating (or the code is valid) → render the scenario.
  //   - 401 → INVITE_CODE is set on the server → flip to invite-required UI
  //          and let the candidate enter the code before the brief loads.
  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: "loading" });
    const stored = getStoredInviteCode();
    getScenarioBySlug(slug, stored ?? undefined)
      .then((scenario) => {
        if (cancelled) return;
        if (stored) setValidatedInviteCode(stored);
        setPhase({ kind: "ready", scenario });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ScenarioNotFoundError) {
          setPhase({ kind: "not-found" });
        } else if (err instanceof ScenarioInviteRequiredError) {
          setPhase({ kind: "invite-required", inviteError: null, submitting: false });
        } else {
          const message = err instanceof Error ? err.message : "Failed to load assessment";
          setPhase({ kind: "error", message });
        }
      });
    return () => { cancelled = true; };
  }, [slug]);

  async function submitInvite(code: string): Promise<void> {
    const trimmed = code.trim();
    if (!trimmed) {
      setPhase({ kind: "invite-required", inviteError: "Enter the invite code.", submitting: false });
      return;
    }
    setPhase({ kind: "invite-required", inviteError: null, submitting: true });
    try {
      const scenario = await getScenarioBySlug(slug, trimmed);
      setValidatedInviteCode(trimmed);
      storeInviteCode(trimmed);
      setPhase({ kind: "ready", scenario });
    } catch (err) {
      if (err instanceof ScenarioInviteRequiredError) {
        setPhase({ kind: "invite-required", inviteError: "That code didn't work. Check it and try again.", submitting: false });
      } else if (err instanceof ScenarioNotFoundError) {
        setPhase({ kind: "not-found" });
      } else {
        const message = err instanceof Error ? err.message : "Failed to load assessment";
        setPhase({ kind: "error", message });
      }
    }
  }

  async function begin(scenario: Scenario): Promise<void> {
    setPhase({ kind: "starting", scenario });
    try {
      // Reuse the code that already passed the scenario gate (when set);
      // fall back to whatever the candidate has typed (covers the case
      // where INVITE_CODE is unset and the field is just decorative).
      const trimmedCode = (validatedInviteCode ?? inviteCode).trim();
      const { sessionId } = await createSession({
        scenarioId: scenario.id,
        ...(trimmedCode ? { inviteCode: trimmedCode } : {}),
        // Single-use session link — the server validates + consumes it; a dead
        // link (expired/consumed/revoked) rejects with a message we surface
        // via the starting-failed phase below.
        ...(linkToken ? { linkToken } : {}),
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

        {phase.kind === "invite-required" && (
          <Card padding={6}>
            <SectionLabel tone="eyebrow">Invite required</SectionLabel>
            <div style={{ fontSize: 22, color: color.text.primary, fontWeight: 600, marginTop: 14, marginBottom: 8 }}>
              Enter your invite code
            </div>
            <div style={{ color: color.text.secondary, fontSize: 13, marginBottom: 18, lineHeight: 1.6 }}>
              This assessment is gated. Paste the code from your invite to load the brief.
            </div>
            <form
              onSubmit={(e) => { e.preventDefault(); void submitInvite(inviteCode); }}
              style={{ display: "flex", flexDirection: "column", gap: 10 }}
            >
              <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span style={{ fontSize: 12, color: color.text.muted }}>Invite code</span>
                <input
                  type="text"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  disabled={phase.submitting}
                  autoFocus
                  placeholder="Paste the code from your invite"
                  autoComplete="off"
                  spellCheck={false}
                  style={{
                    width: 320,
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
              {phase.inviteError && (
                <p style={{ color: color.error.base, fontSize: 12, margin: "2px 0 4px" }}>
                  {phase.inviteError}
                </p>
              )}
              <div>
                <Button
                  variant="primary"
                  size="md"
                  disabled={phase.submitting || inviteCode.trim().length === 0}
                  onClick={() => void submitInvite(inviteCode)}
                >
                  {phase.submitting ? "Checking…" : "Load assessment"}
                </Button>
              </div>
            </form>
          </Card>
        )}

        {(phase.kind === "ready" || phase.kind === "starting" || phase.kind === "starting-failed") && (
          <ScenarioBody
            scenario={phase.scenario}
            starting={phase.kind === "starting"}
            beginError={phase.kind === "starting-failed" ? phase.message : null}
            inviteCode={inviteCode}
            onInviteCodeChange={setInviteCode}
            hideInviteField={validatedInviteCode !== null}
            onBegin={() => { void begin(phase.scenario); }}
          />
        )}
      </div>
    </main>
  );
}

function ScenarioBody({
  scenario, starting, beginError, inviteCode, onInviteCodeChange, hideInviteField, onBegin,
}: {
  scenario: Scenario;
  starting: boolean;
  beginError: string | null;
  inviteCode: string;
  onInviteCodeChange: (v: string) => void;
  /** When true, the invite code was already validated on the scenario fetch
   *  (the gated path). No need to ask again on Begin — hide the field. */
  hideInviteField: boolean;
  onBegin: () => void;
}) {
  const c = scenario.constraints;
  return (
    <div>
      <div style={{ marginBottom: 36 }}>
        <SectionLabel tone="eyebrow">
          Real work capability assessment
        </SectionLabel>
        <h1 style={{
          fontFamily: font.mono,
          fontSize: "clamp(2rem, 4.6vw, 3.4rem)",
          color: color.text.primary,
          margin: "20px 0 0",
          fontWeight: 600,
          letterSpacing: "-0.04em",
          lineHeight: 1.02,
          textWrap: "balance",
        }}>
          {scenario.title}
        </h1>
        <div style={{ marginTop: 18 }}>
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
        <SectionLabel>How to approach this</SectionLabel>
        <ul style={{
          color: color.text.primary,
          fontSize: 14, lineHeight: 1.7,
          margin: 0, marginTop: 12, paddingLeft: 20,
        }}>
          <li style={{ marginBottom: 4 }}>
            <strong style={{ color: color.text.primary, fontWeight: 600 }}>Investigate before you trust</strong>,{" "}
            including this brief and anyone you talk to. Verify with the data,
            not with the loudest opinion in the room.
          </li>
          <li style={{ marginBottom: 4 }}>
            <strong style={{ color: color.text.primary, fontWeight: 600 }}>Expect more than one thing might be wrong.</strong>{" "}
            If so, rank what you find by business impact and lead with what to
            fix first.
          </li>
          <li style={{ marginBottom: 4 }}>
            <strong style={{ color: color.text.primary, fontWeight: 600 }}>When someone pushes a hypothesis at you with confidence</strong>,
            bring evidence before you accept or reject it. Numbers beat
            assertions.
          </li>
          <li style={{ marginBottom: 4 }}>
            <strong style={{ color: color.text.primary, fontWeight: 600 }}>Communicate as you go.</strong>{" "}
            Your client is in the room and wants to know what you&apos;re
            seeing. Translate the technical into the business.
          </li>
          <li>
            <strong style={{ color: color.text.primary, fontWeight: 600 }}>We score how you work, not just what you ship.</strong>{" "}
            Process counts. So does &ldquo;I don&apos;t know yet, here&apos;s
            how I&apos;ll find out.&rdquo;
          </li>
        </ul>
      </section>

      <section style={{ marginBottom: 28 }}>
        <SectionLabel>What we score</SectionLabel>
        <div style={{ color: color.text.secondary, fontSize: 12, marginTop: 8, marginBottom: 14, lineHeight: 1.6 }}>
          Eight dimensions, weighted by what the role demands. Anchors are
          principle-based: there&apos;s no checklist to game.
        </div>
        <ul style={{
          color: color.text.primary,
          fontSize: 13, lineHeight: 1.65,
          margin: 0, paddingLeft: 20,
        }}>
          <li style={{ marginBottom: 4 }}>
            <strong style={{ color: color.text.primary, fontWeight: 600 }}>Problem framing</strong>{": "}
            <span style={{ color: color.text.secondary }}>how well you set up the question before chasing answers.</span>
          </li>
          <li style={{ marginBottom: 4 }}>
            <strong style={{ color: color.text.primary, fontWeight: 600 }}>Data fluency</strong>{": "}
            <span style={{ color: color.text.secondary }}>exploration, verification, and the queries you choose to write.</span>
          </li>
          <li style={{ marginBottom: 4 }}>
            <strong style={{ color: color.text.primary, fontWeight: 600 }}>Design under constraints</strong>{": "}
            <span style={{ color: color.text.secondary }}>prioritization, budget discipline, what you choose not to do.</span>
          </li>
          <li style={{ marginBottom: 4 }}>
            <strong style={{ color: color.text.primary, fontWeight: 600 }}>Execution</strong>{": "}
            <span style={{ color: color.text.secondary }}>does it actually run, and does it match what you said it would.</span>
          </li>
          <li style={{ marginBottom: 4 }}>
            <strong style={{ color: color.text.primary, fontWeight: 600 }}>AI orchestration</strong>{": "}
            <span style={{ color: color.text.secondary }}>using the assistant as a tool, not a crutch. Verify its output.</span>
          </li>
          <li style={{ marginBottom: 4 }}>
            <strong style={{ color: color.text.primary, fontWeight: 600 }}>Teamwork</strong>{": "}
            <span style={{ color: color.text.secondary }}>engaging your teammate, pushing back when warranted, with evidence.</span>
          </li>
          <li style={{ marginBottom: 4 }}>
            <strong style={{ color: color.text.primary, fontWeight: 600 }}>Customer engagement</strong>{": "}
            <span style={{ color: color.text.secondary }}>keeping your stakeholder in the loop, absorbing change calmly.</span>
          </li>
          <li>
            <strong style={{ color: color.text.primary, fontWeight: 600 }}>Outcome communication</strong>{": "}
            <span style={{ color: color.text.secondary }}>clarity, structure, and audience-fit for a non-technical reader.</span>
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
            Submit when you&apos;re confident. Drafts are allowed and the latest version wins.
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

      <section style={{ marginBottom: 32 }}>
        <SectionLabel>Session integrity</SectionLabel>
        <p style={{ color: color.text.muted, fontSize: 12, margin: "8px 0 0", lineHeight: 1.6 }}>
          During the session we record passive integrity signals from this
          browser tab — tab focus changes, large paste bursts, long idle gaps,
          and copy events from the brief and docs. Reviewers see these as
          informational signals only; they never change your competency score.
          No webcam, no biometrics.
        </p>
      </section>

      <div style={{
        display: "flex", flexDirection: "column",
        alignItems: "flex-start", gap: 14,
        paddingTop: 4,
      }}>
        {!hideInviteField && (
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
        )}
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
