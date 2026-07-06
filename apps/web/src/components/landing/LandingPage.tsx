"use client";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { color, font, radius } from "@/styles/tokens";
import Wordmark from "@/components/ui/Wordmark";
import CubeFlame from "@/components/ui/CubeFlame";
import SectionLabel from "@/components/ui/SectionLabel";
import Button from "@/components/ui/Button";
import Reveal from "./Reveal";
import CountUp from "./CountUp";

// Canvas-heavy fire layers are client-only and tree-split out of the initial
// payload so the marketing page still renders fast on first paint.
const EmberCanvas = dynamic(() => import("./EmberCanvas"), { ssr: false });
const FlameCube = dynamic(() => import("./FlameCube"), { ssr: false });

const MAXW = 1180;

// Where every "Start the assessment" CTA on the landing page points. The
// catalog lists every scenario; the per-scenario start screen is one click
// further in.
const ASSESSMENT_HREF = "/scenarios";
const CONTACT_HREF = "/contact";

const WRAP_STYLE = {
  width: "100%",
  maxWidth: MAXW,
  margin: "0 auto",
  padding: "0 32px",
} as const;

const SECTION_PAD = "clamp(72px, 11vw, 140px) 0";

export default function LandingPage(): React.ReactElement {
  return (
    <>
      <EmberCanvas intensity={40} hue={26} />
      <div className="landing-vignette" />
      <div style={{ position: "relative", zIndex: 2 }}>
        <Nav />
        <Hero />
        <Ticker />
        <Problem />
        <Void />
        <Engine />
        <Simulation />
        <Signal />
        <Impact />
        <CTABand />
        <Footer />
      </div>
    </>
  );
}

/* ─────────────────────────────────────────────────────────────── Nav */

function Nav() {
  const links = [
    { href: "#problem", label: "The problem" },
    { href: "#engine", label: "How it works" },
    { href: "#simulation", label: "The simulation" },
    { href: "#signal", label: "The signal" },
  ];
  return (
    <nav
      style={{
        position: "fixed",
        top: 0, left: 0, right: 0,
        zIndex: 40,
        background: "rgba(15, 19, 16, 0.82)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        borderBottom: `1px solid ${color.border.default}`,
      }}
    >
      <div style={{ ...WRAP_STYLE, display: "flex", alignItems: "center", justifyContent: "space-between", height: 66 }}>
        <Wordmark size={24} />
        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          <div className="nav-links" style={{ display: "flex", alignItems: "center", gap: 26 }}>
            {links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                style={{
                  fontFamily: font.mono,
                  fontSize: 12,
                  letterSpacing: "0.04em",
                  color: color.text.secondary,
                }}
              >
                {l.label}
              </a>
            ))}
          </div>
          <Button href={ASSESSMENT_HREF} variant="primary" size="md">
            Start the assessment
          </Button>
        </div>
      </div>
    </nav>
  );
}

/* ─────────────────────────────────────────────────────────────── Hero */

function Hero() {
  return (
    <header
      style={{
        minHeight: "92svh",
        display: "flex",
        alignItems: "center",
        paddingTop: 66,
      }}
    >
      <div style={{
        ...WRAP_STYLE,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 24, flexWrap: "wrap",
      }}>
        <div style={{ maxWidth: 720, flex: "1 1 520px" }}>
          <Reveal>
            <span style={{
              fontFamily: font.mono,
              fontSize: 11.5,
              fontWeight: 500,
              letterSpacing: "0.28em",
              textTransform: "uppercase",
              color: color.accent.base,
              display: "inline-flex",
              alignItems: "center",
              gap: 12,
            }}>
              <span style={{ width: 8, height: 8, background: color.accent.base, flex: "none" }} />
              dynamic work simulations · built for AI-era roles
            </span>
            <h1 style={{
              fontFamily: font.sans,
              fontSize: "clamp(2.6rem, 6.4vw, 5.2rem)",
              fontWeight: 600,
              letterSpacing: "-0.035em",
              lineHeight: 1.04,
              margin: "30px 0 0",
              textWrap: "balance",
              color: color.text.primary,
            }}>
              The nature of work has changed.<br />
              <span className="accent-text">The way we assess must too.</span>
            </h1>
            <p style={{
              color: color.text.secondary,
              fontSize: "clamp(1.05rem, 1.4vw, 1.25rem)",
              lineHeight: 1.65,
              maxWidth: "58ch",
              margin: "28px 0 0",
            }}>
              asaya is simulation-based assessment for AI-augmented engineers: a
              personalized sandbox that scores how people{" "}
              <em style={{ color: color.text.primary, fontStyle: "normal", fontWeight: 500 }}>actually</em>{" "}
              work with AI, under real constraints.
            </p>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 38 }}>
              <Button href={ASSESSMENT_HREF} variant="primary" size="lg">Try the simulation →</Button>
              <Button href="#engine" variant="ghost" size="lg">See how it works</Button>
            </div>
          </Reveal>
          <Reveal delay={250}>
            <HeroChips />
          </Reveal>
        </div>
        {/* The sandbox itself: a wireframe cube with fire burning inside. */}
        <div className="hero-cube" style={{ flex: "0 0 auto", marginRight: -34 }}>
          <Reveal delay={150}>
            <FlameCube size={215} intensity={62} hue={26} />
          </Reveal>
        </div>
      </div>
    </header>
  );
}

/* ─────────────────────────────────────────────────────────────── Ticker */

function Ticker() {
  const items = [
    "behavioural telemetry", "live-proctored", "dynamic scenario engine",
    "evidence you can audit", "AI-Fluency Index™", "real constraints",
  ];
  const strip = (hidden: boolean) => (
    <span aria-hidden={hidden || undefined} style={{ display: "inline-flex", alignItems: "center" }}>
      {items.map((t) => (
        <span key={t} style={{ display: "inline-flex", alignItems: "center" }}>
          <span style={{
            width: 6, height: 6, background: color.fire.base,
            margin: "0 28px", flex: "none",
          }} />
          <span style={{
            fontFamily: font.mono, fontSize: 12, fontWeight: 500,
            letterSpacing: "0.22em", textTransform: "uppercase",
            color: color.text.secondary, whiteSpace: "nowrap",
          }}>
            {t}
          </span>
        </span>
      ))}
    </span>
  );
  return (
    <div
      className="ticker"
      style={{
        borderTop: `1px solid ${color.border.default}`,
        borderBottom: `1px solid ${color.border.default}`,
        padding: "16px 0",
        background: "rgba(15, 19, 16, 0.6)",
      }}
    >
      <div className="ticker-track">
        {strip(false)}
        {strip(true)}
      </div>
    </div>
  );
}

function HeroChips() {
  const items = ["AI-Fluency Index™", "Behavioural Telemetry", "Advanced Proctoring", "Dynamic"];
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 56 }}>
      {items.map((t) => (
        <span key={t} style={{
          fontFamily: font.mono, fontSize: 11.5, fontWeight: 500, letterSpacing: "0.14em",
          textTransform: "uppercase", color: color.text.secondary,
          border: `1px solid ${color.border.strong}`, borderRadius: radius.sm,
          padding: "9px 14px", whiteSpace: "nowrap",
        }}>
          {t}
        </span>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────── Problem */

function Problem() {
  const signals = [
    { badge: "broken",       t: "Résumés",    p: "Written by a model, tuned for the keyword filter. Optimized to pass, not to predict." },
    { badge: "unverifiable", t: "Portfolios", p: "AI-generated and borrowed. You can no longer tell whose work you are looking at." },
    { badge: "gamed",        t: "Interviews", p: "Candidates use AI to apply. Companies use AI to filter. Real talent gets lost in the middle." },
  ];
  const stats = [
    { n: 75, suffix: "%", p: <>of companies report a <b style={{ color: color.text.primary }}>bad hire this year</b> due to flawed assessment.</> },
    { n: 85, suffix: "%", p: <>of interview performance <b style={{ color: color.text.primary }}>doesn&apos;t correlate</b> with actual job performance.</> },
    { raw: "1 in 4", p: <>profiles <b style={{ color: color.text.primary }}>will be fake</b> by 2028.</> },
    { raw: "3 in 4", p: <>managers have already faced <b style={{ color: color.text.primary }}>AI-generated applications</b>.</> },
  ];
  return (
    <section id="problem" style={{ padding: SECTION_PAD, borderTop: `1px solid ${color.border.default}` }}>
      <div style={WRAP_STYLE}>
        <Reveal>
          <div style={{ marginBottom: 48, maxWidth: 820 }}>
            <SectionLabel tone="eyebrow">02 · the problem</SectionLabel>
            <h2 style={sectionTitleStyle()}>
              Every signal is <span className="accent-text">broken</span>.
            </h2>
            <p style={leadStyle({ marginTop: 22 })}>
              Layering AI over a broken process multiplies the chaos and the noise.
              Every proxy we trusted is now synthetic.
            </p>
          </div>
        </Reveal>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 20 }}>
          {signals.map((it, i) => (
            <Reveal key={it.t} delay={i * 110}>
              <div className="card-interactive" style={{
                border: `1px solid ${color.border.default}`,
                background: color.bg.panel,
                padding: "26px 26px 28px",
                borderRadius: radius.md,
                position: "relative",
                overflow: "hidden",
                height: "100%",
                transition: "border-color 300ms ease, transform 300ms ease",
              }}>
                <span style={{
                  fontFamily: font.mono, fontSize: 11, fontWeight: 600, letterSpacing: "0.18em",
                  textTransform: "uppercase", color: color.accent.base,
                  border: `1px solid ${color.border.strong}`, borderRadius: radius.sm, padding: "4px 9px",
                }}>
                  {it.badge}
                </span>
                <h3 style={{
                  fontFamily: font.sans, fontWeight: 600, fontSize: "1.4rem",
                  letterSpacing: "-0.02em", margin: "18px 0 10px", color: color.text.primary,
                }}>{it.t}</h3>
                <p style={{ color: color.text.secondary, margin: 0, fontSize: "0.97rem", lineHeight: 1.6 }}>{it.p}</p>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal delay={120}>
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 1,
            background: color.border.default, border: `1px solid ${color.border.default}`,
            borderRadius: radius.md, overflow: "hidden", marginTop: 20,
          }}>
            {stats.map((s, i) => (
              <div key={i} style={{ background: color.bg.page, padding: "26px 26px 28px" }}>
                <div style={{
                  fontFamily: font.mono, fontWeight: 600, fontSize: "clamp(1.9rem, 3.4vw, 2.6rem)",
                  letterSpacing: "-0.03em", lineHeight: 1, color: color.text.primary,
                }}>
                  {s.raw ?? <CountUp end={s.n} suffix={s.suffix} />}
                </div>
                <p style={{ color: color.text.secondary, fontSize: "0.93rem", lineHeight: 1.55, margin: "14px 0 0" }}>{s.p}</p>
              </div>
            ))}
          </div>
        </Reveal>
        <Reveal>
          <p style={{
            fontFamily: font.sans, fontSize: "clamp(1.05rem, 1.7vw, 1.35rem)", fontWeight: 600,
            letterSpacing: "-0.015em", lineHeight: 1.45, color: color.text.primary,
            borderLeft: `2px solid ${color.accent.base}`, paddingLeft: 22, margin: "44px 0 0",
          }}>
            Every fake signal adds another interview a human must absorb.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────── Void */

function Void() {
  const capabilities = ["Code correctness", "AI orchestration", "Judgement / ambiguity", "Product mindset", "Stakeholder communication"];
  const tools = [
    { t: "Coding screens",   s: "HackerRank · Codility",      marks: ["✓", "✗", "✗", "✗", "✗"] },
    { t: "Take-homes",       s: "AI-written · unverifiable",  marks: ["AI-done", "✗", "✗", "✗", "✗"] },
    { t: "Human interviews", s: "$200–450/hr · inconsistent", marks: ["✗", "✗", "weak proxy", "✗", "✗"] },
  ];
  const demand = [
    { n: 181, unit: "YoY", l: "AI-augmented engineering" },
    { n: 729, unit: "YoY", l: "Forward-deployed engineering" },
    { n: 63,  unit: "/yr", l: "AI engineer, the #1 fastest-growing role" },
  ];
  return (
    <section id="void" style={{ padding: SECTION_PAD, borderTop: `1px solid ${color.border.default}` }}>
      <div style={WRAP_STYLE}>
        <Reveal>
          <div style={{ marginBottom: 48, maxWidth: 860 }}>
            <SectionLabel tone="eyebrow">03 · the assessment void</SectionLabel>
            <h2 style={sectionTitleStyle()}>
              The job changed.<br />
              <span className="accent-text">What we measure has not.</span>
            </h2>
            <p style={leadStyle({ marginTop: 22 })}>
              Every legacy assessment skips four of the five skills that make an
              AI-augmented engineer. The void compounds daily.
            </p>
          </div>
        </Reveal>

        {/* capability matrix */}
        <Reveal>
          <div style={{ overflowX: "auto", border: `1px solid ${color.border.default}`, borderRadius: radius.md }}>
            <table style={{ width: "100%", minWidth: 760, borderCollapse: "collapse", background: color.bg.panel }}>
              <thead>
                <tr>
                  <th style={matrixHeadStyle({ textAlign: "left" })}>legacy tools</th>
                  {capabilities.map((c) => (
                    <th key={c} style={matrixHeadStyle()}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tools.map((row) => (
                  <tr key={row.t}>
                    <td style={{ ...matrixCellStyle(), textAlign: "left", whiteSpace: "nowrap" }}>
                      <div style={{ fontFamily: font.sans, fontWeight: 600, fontSize: "0.98rem", color: color.text.primary }}>{row.t}</div>
                      <div style={{ fontFamily: font.mono, fontSize: 10.5, letterSpacing: "0.04em", color: color.text.muted, marginTop: 4 }}>{row.s}</div>
                    </td>
                    {row.marks.map((m, i) => (
                      <td key={i} style={{
                        ...matrixCellStyle(),
                        fontFamily: font.mono,
                        fontSize: m.length > 1 ? 11 : 14,
                        letterSpacing: m.length > 1 ? "0.08em" : undefined,
                        textTransform: m.length > 1 ? "uppercase" : undefined,
                        color: m === "✓" ? color.accent.base : color.text.secondary,
                      }}>
                        {m}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>

        {/* demand stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 20, marginTop: 20 }}>
          {demand.map((d, i) => (
            <Reveal key={d.l} delay={i * 110}>
              <div style={{
                border: `1px solid ${color.border.default}`, background: color.bg.panel,
                borderRadius: radius.md, padding: "24px 26px", height: "100%",
                display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap",
              }}>
                <span style={{
                  fontFamily: font.mono, fontWeight: 600, fontSize: "clamp(1.7rem, 3vw, 2.2rem)",
                  letterSpacing: "-0.03em", lineHeight: 1, color: color.accent.base,
                }}>
                  <CountUp end={d.n} prefix="+" suffix="%" />{" "}
                  <span style={{ fontSize: "0.5em", color: color.text.muted, letterSpacing: "0.08em" }}>{d.unit}</span>
                </span>
                <span style={{ color: color.text.secondary, fontSize: "0.92rem", lineHeight: 1.4 }}>{d.l}</span>
              </div>
            </Reveal>
          ))}
        </div>
        <p style={{ color: color.text.muted, fontFamily: font.mono, fontSize: 11, letterSpacing: "0.10em", textTransform: "uppercase", margin: "20px 0 0" }}>
          source: Dice · Lightcast · BLS · SHRM · 2026
        </p>
      </div>
    </section>
  );
}

function matrixHeadStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    fontFamily: font.mono, fontSize: 10.5, fontWeight: 600, letterSpacing: "0.14em",
    textTransform: "uppercase", color: color.text.secondary,
    padding: "16px 18px", textAlign: "center",
    borderBottom: `1px solid ${color.border.default}`,
    background: color.bg.elevated,
    ...extra,
  };
}

function matrixCellStyle(): React.CSSProperties {
  return {
    padding: "18px 18px",
    textAlign: "center",
    borderBottom: `1px solid ${color.border.subtle}`,
  };
}

/* ─────────────────────────────────────────────────────────────── Engine */

function Engine() {
  const steps = [
    { n: "01", t: "Quick intake", p: "A five-minute form on your stack, the role, and the capabilities that matter. Everything we need to build your simulation, nothing more.", tag: "~5 minutes" },
    { n: "02", t: "Intelligence engine", p: "The asaya engine personalizes and calibrates a simulation from your real environment: your tools, your problems, fixed in difficulty." },
    { n: "03", t: "Personalized sandbox", p: "A browser-accessible workspace with live personas, an AI assistant, and real-world constraints. Generated in seconds, not months." },
    { n: "04", t: "Scientific evaluation", p: "Behavioural telemetry captures every decision, prompt, and recovery as it happens. Every action scored; every score evidence-linked." },
    { n: "05", t: "Capability, measured", p: "A full competency profile and an AI-Fluency Index™ come out the other side: ranked, comparable, and fully auditable.", hot: true },
  ];
  return (
    <section id="engine" style={{ padding: SECTION_PAD, borderTop: `1px solid ${color.border.default}` }}>
      <div style={WRAP_STYLE}>
        <Reveal>
          <div style={{ marginBottom: 48, display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 28, flexWrap: "wrap" }}>
            <div style={{ maxWidth: 640 }}>
              <SectionLabel tone="eyebrow">04 · how it works</SectionLabel>
              <h2 style={sectionTitleStyle()}>
                Your environment in.<br />
                A <span className="accent-text">calibrated simulation</span> out.
              </h2>
            </div>
            <p style={leadStyle({ maxWidth: 380 })}>
              A five-minute setup generates a personalized, browser-accessible sandbox
              simulation, rooted in evidence-based assessment science.
            </p>
          </div>
        </Reveal>
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 1,
          background: color.border.default,
          border: `1px solid ${color.border.default}`,
          borderRadius: radius.md, overflow: "hidden",
        }}>
          {steps.map((s, i) => (
            <Reveal key={s.n} delay={i * 90} style={{ height: "100%" }}>
              <div style={{
                background: s.hot ? color.bg.selected : color.bg.page,
                padding: "30px 26px 34px",
                height: "100%",
              }}>
                <div style={{
                  fontFamily: font.mono, fontSize: 11, letterSpacing: "0.20em", textTransform: "uppercase",
                  color: s.hot ? color.accent.base : color.text.muted,
                }}>
                  stage {s.n}
                </div>
                <h3 style={{
                  fontFamily: font.sans, fontWeight: 600, fontSize: "1.16rem",
                  letterSpacing: "-0.015em", margin: "16px 0 12px",
                  color: s.hot ? color.accent.base : color.text.primary,
                }}>{s.t}</h3>
                {s.tag && (
                  <span style={{
                    display: "inline-block", marginBottom: 12,
                    fontFamily: font.mono, fontSize: 10.5, fontWeight: 600, letterSpacing: "0.14em",
                    textTransform: "uppercase", color: color.accent.base,
                    border: `1px solid ${color.border.strong}`, borderRadius: radius.sm, padding: "4px 9px",
                  }}>{s.tag}</span>
                )}
                <p style={{ color: color.text.secondary, margin: 0, fontSize: "0.93rem", lineHeight: 1.55 }}>{s.p}</p>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal>
          <p style={{
            fontFamily: font.sans, fontSize: "clamp(1.1rem, 2vw, 1.45rem)", fontWeight: 600,
            letterSpacing: "-0.015em", lineHeight: 1.4, color: color.text.primary,
            textAlign: "center", margin: "44px auto 0", textWrap: "balance",
          }}>
            Personalized for fidelity. <span className="accent-text">Standardized for fairness.</span>
          </p>
        </Reveal>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────── Simulation */

// Ticking session clock for the sandbox mock: counts down from 59:07 and
// quietly wraps, so the HUD reads as live without ever hitting zero.
function useTickingClock(): string {
  const [seconds, setSeconds] = useState(59 * 60 + 7);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => {
      setSeconds((s) => (s <= 55 * 60 ? 59 * 60 + 7 : s - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function Simulation() {
  const clock = useTickingClock();
  const constraints = [
    { l: "time",    v: clock,     cap: "/ 90m" },
    { l: "tokens",  v: "200,000", cap: "/ 200,000" },
    { l: "compute", v: "60.00m",  cap: "/ 60m" },
    { l: "money",   v: "$25",     cap: "" },
    { l: "memory",  v: "2,048MB", cap: "" },
  ];
  const tabs = [
    { l: "docs",        note: "" },
    { l: "messages",    note: "teammate & client personas" },
    { l: "data",        note: "database" },
    { l: "terminal",    note: "" },
    { l: "assistant",   note: "AI" },
    { l: "deliverable", note: "desired outcome" },
  ];
  return (
    <section id="simulation" style={{ padding: SECTION_PAD, borderTop: `1px solid ${color.border.default}` }}>
      <div style={WRAP_STYLE}>
        <Reveal>
          <div style={{ marginBottom: 48, maxWidth: 860 }}>
            <SectionLabel tone="eyebrow">05 · inside the simulation</SectionLabel>
            <h2 style={sectionTitleStyle()}>
              One workspace. Every real-world tool.<br />
              <span className="accent-text">Every action, scored and ranked.</span>
            </h2>
            <p style={leadStyle({ marginTop: 22 })}>
              Candidates work in a real, sandboxed dev environment, not a whiteboard.
              Everything the role touches on day one is one tab away.
            </p>
          </div>
        </Reveal>

        {/* sandbox mock: constraint HUD + tab strip */}
        <Reveal>
          <div style={{ border: `1px solid ${color.border.default}`, borderRadius: radius.md, overflow: "hidden" }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 28, flexWrap: "wrap",
              padding: "18px 24px", background: color.bg.elevated,
              borderBottom: `1px solid ${color.border.default}`,
            }}>
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 12,
                fontFamily: font.sans, fontWeight: 600, fontSize: "1.05rem",
                letterSpacing: "-0.01em", color: color.text.primary, marginRight: "auto",
              }}>
                <CubeFlame size={20} />
                Simulation sandbox
              </span>
              {constraints.map((c) => (
                <span key={c.l} style={{ display: "inline-flex", flexDirection: "column", gap: 3 }}>
                  <span style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: color.text.muted }}>{c.l}</span>
                  <span style={{ fontFamily: font.mono, fontSize: 13, fontWeight: 600, color: c.l === "time" ? color.fire.bright : color.text.primary, fontVariantNumeric: "tabular-nums" }}>
                    {c.v} <span style={{ color: color.text.muted, fontWeight: 400 }}>{c.cap}</span>
                  </span>
                </span>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 1, background: color.border.subtle }}>
              {tabs.map((t) => (
                <div key={t.l} style={{ background: color.bg.panel, padding: "22px 20px", minHeight: 92 }}>
                  <span style={{
                    fontFamily: font.mono, fontSize: 12.5, fontWeight: 600, letterSpacing: "0.10em",
                    textTransform: "uppercase", color: color.text.primary,
                    display: "inline-flex", alignItems: "center", gap: 10,
                  }}>
                    <span style={{ width: 6, height: 6, background: color.accent.base, flexShrink: 0 }} />
                    {t.l}
                  </span>
                  {t.note && (
                    <div style={{ fontFamily: font.mono, fontSize: 10.5, letterSpacing: "0.04em", color: color.text.muted, marginTop: 8 }}>
                      {t.note}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 20, marginTop: 20 }}>
          <Reveal delay={0}>
            <FeatureNote tag="Advanced proctoring" p="Live-proctored and identity-verified, end to end, so you know who actually did the work." />
          </Reveal>
          <Reveal delay={120}>
            <FeatureNote tag="Dynamic scenario engine" p="Personalized to the role's environment with progressive difficulty. Never identical, impossible to leak." />
          </Reveal>
        </div>

        <Reveal>
          <p style={{
            fontFamily: font.mono, fontSize: 11.5, letterSpacing: "0.16em", textTransform: "uppercase",
            color: color.text.muted, textAlign: "center", margin: "36px 0 0",
          }}>
            grounded in assessment science:{" "}
            <span style={{ color: color.accent.base }}>fairness · comparability · validity · reliability</span>
          </p>
        </Reveal>
      </div>
    </section>
  );
}

function FeatureNote({ tag, p }: { tag: string; p: string }) {
  return (
    <div style={{ border: `1px solid ${color.border.default}`, background: color.bg.panel, borderRadius: radius.md, padding: "24px 26px", height: "100%" }}>
      <span style={{
        fontFamily: font.mono, fontSize: 11, fontWeight: 600, letterSpacing: "0.20em",
        textTransform: "uppercase", color: color.accent.base,
      }}>{tag}</span>
      <p style={{ color: color.text.secondary, margin: "12px 0 0", fontSize: "0.96rem", lineHeight: 1.6 }}>{p}</p>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────── Signal */

function Signal() {
  const pillars = [
    { n: "01", t: "Core competency", s: "the basics", items: ["Software engineering fundamentals", "Problem decomposition & structuring", "Code quality, accuracy & debugging"] },
    { n: "02", t: "How they work", s: "the process · most important", hot: true, items: ["AI orchestration & prompt design", "Verification & judgment: knows when AI is wrong", "Adaptability when the model fails", "Stakeholder communication & product mindset"] },
    { n: "03", t: "What gets delivered", s: "the outcome", items: ["Deliverable meets brief & constraints", "Resource efficiency: time, tokens, cost", "Stakeholder-ready output"] },
  ];
  return (
    <section id="signal" style={{ padding: SECTION_PAD, borderTop: `1px solid ${color.border.default}` }}>
      <div style={WRAP_STYLE}>
        <Reveal>
          <div style={{ marginBottom: 48, maxWidth: 860 }}>
            <SectionLabel tone="eyebrow">06 · the signal</SectionLabel>
            <h2 style={sectionTitleStyle()}>
              We measure <span className="accent-text">how the answer was built</span>.
            </h2>
            <p style={leadStyle({ marginTop: 22 })}>
              ~5,000 signals per session. Every pixel, every keystroke. Every score
              linked to the exact evidence moments that earned it.
            </p>
          </div>
        </Reveal>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
          {pillars.map((p, i) => (
            <Reveal key={p.n} delay={i * 110} style={{ height: "100%" }}>
              <div style={{
                border: `1px solid ${p.hot ? color.accent.base : color.border.default}`,
                background: p.hot ? color.accent.softer : color.bg.panel,
                borderRadius: radius.md, padding: "26px 26px 28px", height: "100%",
              }}>
                <div style={{ fontFamily: font.mono, fontSize: 11, fontWeight: 600, letterSpacing: "0.18em", textTransform: "uppercase", color: p.hot ? color.accent.base : color.text.muted }}>
                  {p.n} · {p.s}
                </div>
                <h3 style={{ fontFamily: font.sans, fontWeight: 600, fontSize: "1.4rem", letterSpacing: "-0.02em", margin: "12px 0 16px", color: p.hot ? color.accent.base : color.text.primary }}>
                  {p.t}
                </h3>
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                  {p.items.map((it) => (
                    <li key={it} style={{ display: "flex", gap: 11, color: color.text.secondary, fontSize: "0.93rem", lineHeight: 1.5 }}>
                      <span style={{ width: 5, height: 5, background: p.hot ? color.accent.base : color.text.muted, marginTop: 8, flexShrink: 0 }} />
                      {it}
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal>
          <FluencyIndex />
        </Reveal>
      </div>
    </section>
  );
}

function FluencyIndex() {
  const levels = [
    { t: "AI-Dependent",    p: "Leans on AI for answers; can't tell when it's wrong.", tone: "muted" as const },
    { t: "AI-Augmented",    p: "Directs AI well and verifies it; a reliable, productive contributor.", tone: "mid" as const },
    { t: "AI-Orchestrator", p: "Multiplies output, catches model failures, and knows when not to use it.", tone: "hot" as const },
  ];
  const c = (tone: "muted" | "mid" | "hot") =>
    tone === "hot" ? color.accent.base : tone === "mid" ? color.text.primary : color.text.muted;
  return (
    <div style={{
      marginTop: 20, border: `1px solid ${color.border.default}`, borderRadius: radius.md,
      padding: "28px 30px 30px", background: color.bg.panel,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}>
        <span style={{ fontFamily: font.sans, fontWeight: 600, fontSize: "1.35rem", letterSpacing: "-0.02em", color: color.text.primary }}>
          AI-Fluency Index<span style={{ color: color.accent.base, fontSize: "0.6em", verticalAlign: "super" }}>™</span>
        </span>
        <span style={{ fontFamily: font.mono, fontSize: 11, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: color.text.secondary }}>
          a calibrated spectrum to measure AI orchestration
        </span>
      </div>
      {/* spectrum bar: dependent → augmented → orchestrator */}
      <div style={{ position: "relative", margin: "30px 0 24px" }}>
        <div style={{ height: 8, borderRadius: radius.sm, background: `linear-gradient(90deg, ${color.bg.selected}, ${color.accent.deep} 55%, ${color.accent.base} 90%, ${color.accent.bright})` }} />
        {[16, 50, 84].map((left, i) => (
          <span key={left} style={{
            position: "absolute", left: `${left}%`, top: "50%", transform: "translate(-50%, -50%)",
            width: i === 2 ? 14 : 10, height: i === 2 ? 14 : 10,
            background: i === 2 ? color.accent.base : color.bg.page,
            border: `2px solid ${i === 2 ? color.accent.bright : i === 1 ? color.text.secondary : color.text.muted}`,
          }} />
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 24 }}>
        {levels.map((l) => (
          <div key={l.t} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontFamily: font.mono, fontWeight: 600, fontSize: "1rem", letterSpacing: "-0.01em", color: c(l.tone) }}>{l.t}</span>
            <p style={{ color: l.tone === "hot" ? color.text.secondary : color.text.muted, fontSize: "0.9rem", lineHeight: 1.5, margin: 0 }}>{l.p}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────── Impact */

function Impact() {
  const metrics = [
    { end: 10, suffix: "×", l: "faster screening" },
    { end: 95, suffix: "%", l: "cost saving" },
    { end: 90, suffix: "%", l: "SME time saved" },
    { raw: "40 → 4", l: "interviews per 20 candidates" },
  ];
  return (
    <section id="impact" style={{ padding: SECTION_PAD, borderTop: `1px solid ${color.border.default}` }}>
      <div style={WRAP_STYLE}>
        <Reveal>
          <div style={{ marginBottom: 48, maxWidth: 860 }}>
            <SectionLabel tone="eyebrow">07 · the impact</SectionLabel>
            <h2 style={sectionTitleStyle()}>
              Evaluate 20 candidates in{" "}
              <span className="accent-text">4 interviews instead of 40</span>.
            </h2>
            <p style={leadStyle({ marginTop: 22 })}>
              Keep the SME judgment that can&apos;t be replaced. asaya absorbs the broken
              middle, replacing manual screening with automated, work-evidence-based
              assessment.
            </p>
          </div>
        </Reveal>
        <Reveal>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 1, background: color.border.default, border: `1px solid ${color.border.default}`, borderRadius: radius.md, overflow: "hidden" }}>
            {metrics.map((m) => (
              <div key={m.l} style={{ background: color.bg.page, padding: "34px 28px 36px" }}>
                <div style={{ fontFamily: font.mono, fontWeight: 600, fontSize: "clamp(2rem, 4vw, 2.9rem)", letterSpacing: "-0.03em", lineHeight: 0.9, color: color.accent.base }}>
                  {m.raw ?? <CountUp end={m.end} suffix={m.suffix} />}
                </div>
                <div style={{ fontFamily: font.mono, fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase", color: color.text.secondary, marginTop: 14 }}>{m.l}</div>
              </div>
            ))}
          </div>
        </Reveal>
        <Reveal>
          <p style={{
            fontFamily: font.sans, fontWeight: 600,
            fontSize: "clamp(1.05rem, 1.85vw, 1.4rem)",
            letterSpacing: "-0.015em", lineHeight: 1.4,
            color: color.text.primary, textAlign: "center",
            textWrap: "balance",
            margin: "52px auto 0",
            paddingTop: 36,
            borderTop: `2px solid ${color.accent.base}`,
          }}>
            Reducing the immeasurable cost of missed talent.{" "}
            <span className="accent-text">Giving genuinely capable people a fair shot.</span>
          </p>
        </Reveal>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────── CTA band */

function CTABand() {
  return (
    <section id="company" style={{
      textAlign: "center",
      padding: "clamp(90px, 13vw, 160px) 0",
      borderTop: `1px solid ${color.border.default}`,
    }}>
      <div style={WRAP_STYLE}>
        <Reveal>
          <div style={{ display: "flex", justifyContent: "center", marginTop: -46, marginBottom: -52 }}>
            <FlameCube size={124} intensity={70} hue={26} />
          </div>
          <span style={{
            fontFamily: font.mono, fontSize: 11.5, fontWeight: 500,
            letterSpacing: "0.28em", textTransform: "uppercase",
            color: color.accent.base, display: "inline-block",
          }}>ready when you are</span>
          <h2 style={{
            fontFamily: font.sans, fontWeight: 600,
            fontSize: "clamp(2.2rem, 5.6vw, 4.2rem)",
            letterSpacing: "-0.035em", lineHeight: 1.04,
            margin: "22px 0 0", color: color.text.primary,
            textWrap: "balance",
          }}>
            Measure what <span className="accent-text">matters</span>.
          </h2>
          <p style={leadStyle({ margin: "24px auto 0", textAlign: "center" })}>
            Run a pilot with one role. See real signal in a week, and never read
            another ghost-written résumé.
          </p>
          <div style={{ display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap", marginTop: 38 }}>
            <Button href={ASSESSMENT_HREF} variant="primary" size="lg">Try the simulation →</Button>
            <Button href={CONTACT_HREF} variant="ghost" size="lg">Talk to us</Button>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────── Footer */

function Footer() {
  return (
    <footer style={{ borderTop: `1px solid ${color.border.default}`, padding: "56px 0 40px" }}>
      <div style={WRAP_STYLE}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 30, flexWrap: "wrap" }}>
          <div style={{ maxWidth: "34ch" }}>
            <Wordmark size={24} />
            <p style={{
              color: color.text.secondary, fontSize: "0.92rem",
              marginTop: 18, lineHeight: 1.65,
            }}>
              Simulation-based assessment for AI-augmented engineers.<br />
              Measure what matters.
            </p>
          </div>
          <div style={{ display: "flex", gap: 60, flexWrap: "wrap" }}>
            <FooterCol
              heading="Product"
              links={[
                { href: "#problem", label: "The problem" },
                { href: "#engine", label: "How it works" },
                { href: "#simulation", label: "The simulation" },
                { href: "#signal", label: "The signal" },
              ]}
            />
            <FooterCol
              heading="Get started"
              links={[
                { href: ASSESSMENT_HREF, label: "Try the simulation" },
                { href: CONTACT_HREF, label: "Talk to us" },
              ]}
            />
          </div>
        </div>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          marginTop: 50, paddingTop: 26, borderTop: `1px solid ${color.border.default}`,
          gap: 16, flexWrap: "wrap",
        }}>
          <span style={{ fontFamily: font.mono, fontSize: 11.5, letterSpacing: "0.08em", color: color.text.muted }}>
            © 2026 asaya · measure what matters
          </span>
          <span style={{ fontFamily: font.mono, fontSize: 11.5, letterSpacing: "0.08em", color: color.text.muted }}>
            dynamic work simulations · built for AI-era roles
          </span>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ heading, links }: { heading: string; links: { href: string; label: string }[] }) {
  return (
    <div>
      <h4 style={{
        fontFamily: font.mono, fontSize: 11, fontWeight: 500,
        letterSpacing: "0.22em", textTransform: "uppercase",
        color: color.text.muted, margin: "0 0 16px",
      }}>{heading}</h4>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        {links.map((l) => (
          <li key={l.label}>
            <a href={l.href} style={{ fontFamily: font.mono, fontSize: 12.5, color: color.text.secondary }}>
              {l.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────── helpers */

function sectionTitleStyle(): React.CSSProperties {
  return {
    fontFamily: font.sans,
    fontWeight: 600,
    letterSpacing: "-0.03em",
    lineHeight: 1.08,
    fontSize: "clamp(1.9rem, 4vw, 3.1rem)",
    margin: "22px 0 0",
    color: color.text.primary,
    textWrap: "balance",
  };
}

function leadStyle(extra: React.CSSProperties = {}): React.CSSProperties {
  return {
    color: color.text.secondary,
    fontSize: "clamp(1rem, 1.35vw, 1.18rem)",
    lineHeight: 1.65,
    maxWidth: "56ch",
    margin: 0,
    ...extra,
  };
}
