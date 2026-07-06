"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { listScenarios, type ScenarioCatalogItem } from "@/lib/api";
import { color, font, radius } from "@/styles/tokens";
import Card from "@/components/ui/Card";
import Pill from "@/components/ui/Pill";
import SectionLabel from "@/components/ui/SectionLabel";
import Button from "@/components/ui/Button";
import Wordmark from "@/components/ui/Wordmark";

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; scenarios: ScenarioCatalogItem[] };

export default function ScenariosCatalog() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    listScenarios()
      .then((scenarios) => {
        if (!cancelled) setPhase({ kind: "ready", scenarios });
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Failed to load catalog";
        setPhase({ kind: "error", message });
      });
    return () => { cancelled = true; };
  }, []);

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
      <div style={{ width: "100%", maxWidth: 880 }}>
        <header style={{
          marginBottom: 36,
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
        }}>
          <Wordmark />
          <Link href="/" style={{ textDecoration: "none" }}>
            <Button variant="ghost" size="sm">Back to overview</Button>
          </Link>
        </header>

        <div style={{ marginBottom: 36 }}>
          <SectionLabel tone="eyebrow">Choose your assessment</SectionLabel>
          <h1
            style={{
              fontFamily: font.mono,
              fontSize: "clamp(2rem, 4.4vw, 3rem)",
              fontWeight: 600,
              letterSpacing: "-0.04em",
              lineHeight: 1.05,
              margin: "20px 0 12px",
              textWrap: "balance",
            }}
          >
            Available simulations
          </h1>
          <p style={{ color: color.text.secondary, fontSize: 14, lineHeight: 1.65, maxWidth: 60 * 8, margin: 0 }}>
            Each simulation drops you into 90 minutes of a real job. Pick the one your invite points
            to. The brief loads once you enter your code on the next screen.
          </p>
        </div>

        {phase.kind === "loading" && (
          <div style={{ color: color.text.muted, fontSize: 14 }}>Loading…</div>
        )}

        {phase.kind === "error" && (
          <Card padding={5}>
            <SectionLabel>Couldn&apos;t load the catalog</SectionLabel>
            <div style={{ color: color.error.base, fontSize: 13, marginTop: 8, marginBottom: 14, lineHeight: 1.5 }}>
              {phase.message}
            </div>
            <Button variant="primary" size="md" onClick={() => setPhase({ kind: "loading" })}>
              Retry
            </Button>
          </Card>
        )}

        {phase.kind === "ready" && phase.scenarios.length === 0 && (
          <Card padding={6}>
            <div style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>
              No assessments available yet
            </div>
            <div style={{ color: color.text.secondary, fontSize: 14, lineHeight: 1.6 }}>
              Contact the recruiter who sent you here.
            </div>
          </Card>
        )}

        {phase.kind === "ready" && phase.scenarios.length > 0 && (
          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "1fr" }}>
            {phase.scenarios.map((s) => (
              <ScenarioCard key={s.slug} scenario={s} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function difficultyTone(d: string | null): "neutral" | "accent" | "warn" | "error" {
  switch ((d ?? "").toLowerCase()) {
    case "easy":   return "neutral";
    case "mid":    return "warn";
    case "hard":   return "error";
    case "expert": return "error";
    default:       return "neutral";
  }
}

function ScenarioCard({ scenario }: { scenario: ScenarioCatalogItem }) {
  return (
    <Link href={`/start/${encodeURIComponent(scenario.slug)}`} style={{ textDecoration: "none", color: "inherit" }}>
      <Card padding={5} interactive>
        <div style={{
          display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontFamily: font.mono, fontSize: 11, letterSpacing: "0.18em",
              textTransform: "uppercase", color: color.text.muted, marginBottom: 8,
            }}>
              {scenario.role}
            </div>
            <div style={{
              fontFamily: font.mono, fontSize: "1.45rem", fontWeight: 600,
              letterSpacing: "-0.02em", color: color.text.primary, lineHeight: 1.2, marginBottom: 12,
              textWrap: "balance",
            }}>
              {scenario.title}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {scenario.difficulty && (
                <Pill tone={difficultyTone(scenario.difficulty)} size="sm">
                  {scenario.difficulty}
                </Pill>
              )}
            </div>
          </div>
          <div style={{
            fontFamily: font.mono, fontSize: 11, letterSpacing: "0.20em",
            textTransform: "uppercase", color: color.accent.base,
            flexShrink: 0, paddingTop: 4,
          }}>
            Start →
          </div>
        </div>
      </Card>
    </Link>
  );
}

// `radius` reserved for future card-level tweaks (e.g. tagline chip).
void radius;
