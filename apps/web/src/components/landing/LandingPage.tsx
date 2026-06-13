"use client";
import Link from "next/link";
import dynamic from "next/dynamic";
import { color, font, radius, gradient } from "@/styles/tokens";
import Wordmark from "@/components/ui/Wordmark";
import SectionLabel from "@/components/ui/SectionLabel";
import Button from "@/components/ui/Button";

// Canvas-heavy components are client-only and tree-split out of the initial
// payload so the marketing page still renders fast on first paint.
const EmberCanvas = dynamic(() => import("./EmberCanvas"), { ssr: false });
const FlameCube = dynamic(() => import("./FlameCube"), { ssr: false });

const MAXW = 1180;

// Where the "Start the assessment" CTA points. The route already exists and
// is the only scenario we ship today; swap to a catalog page when more land.
const ASSESSMENT_HREF = "/start/fde-db-triage";

const WRAP_STYLE = {
  width: "100%",
  maxWidth: MAXW,
  margin: "0 auto",
  padding: "0 32px",
} as const;

const SECTION_PAD = "clamp(72px, 11vw, 150px) 0";

export default function LandingPage(): React.ReactElement {
  return (
    <>
      <EmberCanvas intensity={45} hue={28} />
      <div className="landing-vignette" />
      <div style={{ position: "relative", zIndex: 2 }}>
        <Nav />
        <Hero />
        <Problem />
        <Thesis />
        <Method />
        <SignalVsNoise />
        <CTABand />
        <Footer />
      </div>
    </>
  );
}

/* ─────────────────────────────────────────────────────────────── Nav */

function Nav() {
  return (
    <nav
      style={{
        position: "fixed",
        top: 0, left: 0, right: 0,
        zIndex: 40,
        background: "rgba(4, 3, 2, 0.72)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        borderBottom: `1px solid ${color.border.default}`,
      }}
    >
      <div style={{ ...WRAP_STYLE, display: "flex", alignItems: "center", justifyContent: "space-between", height: 68 }}>
        <Wordmark size={22} />
        <Link href={ASSESSMENT_HREF} style={{ textDecoration: "none" }}>
          <Button variant="primary" size="md">
            Start the assessment
          </Button>
        </Link>
      </div>
    </nav>
  );
}

/* ─────────────────────────────────────────────────────────────── Hero */

function Hero() {
  return (
    <header
      style={{
        minHeight: "100svh",
        display: "flex",
        alignItems: "center",
        paddingTop: 68,
        position: "relative",
      }}
    >
      <div style={{ ...WRAP_STYLE, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
        <div style={{ marginTop: -36, marginBottom: -78 }}>
          <FlameCube size={150} intensity={60} hue={28} />
        </div>
        <div style={{ maxWidth: 880 }}>
          <span style={{
            fontFamily: font.mono,
            fontSize: 11.5,
            fontWeight: 500,
            letterSpacing: "0.28em",
            textTransform: "uppercase",
            color: color.accent.amber,
            display: "inline-block",
          }}>
            real work capability assessment simulation sandbox
          </span>
          <h1 style={{
            fontFamily: font.mono,
            fontSize: "clamp(2.5rem, 7.2vw, 6.2rem)",
            fontWeight: 600,
            letterSpacing: "-0.045em",
            lineHeight: 0.98,
            margin: "26px 0 0",
            textWrap: "balance",
          }}>
            Measure What <span className="fire-text">Matters</span>.
          </h1>
          <p style={{
            color: color.text.secondary,
            fontSize: "clamp(1rem, 1.35vw, 1.18rem)",
            lineHeight: 1.65,
            maxWidth: "56ch",
            margin: "26px auto 0",
          }}>
            Résumés lie, portfolios are borrowed, and AI writes the rest.
            crucible. drops candidates into 90 minutes of the actual job —
            real tools, live context — and scores what they truly do.
          </p>
          <div style={{ display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap", marginTop: 36 }}>
            <Link href={ASSESSMENT_HREF} style={{ textDecoration: "none" }}>
              <Button variant="primary" size="lg">Try the simulation →</Button>
            </Link>
            <a href="#method" style={{ textDecoration: "none" }}>
              <Button variant="ghost" size="lg">See the method</Button>
            </a>
          </div>
          <HeroMeta />
        </div>
      </div>
    </header>
  );
}

function HeroMeta() {
  const items = ["90 min", "real tools", "behavioral telemetry", "multi-parameter signal"];
  return (
    <div style={{
      display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", justifyContent: "center",
      fontFamily: font.mono, fontSize: 11.5, letterSpacing: "0.16em", textTransform: "uppercase",
      color: color.text.muted, marginTop: 40,
    }}>
      {items.map((t, i) => (
        <span key={t} style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          <span style={{ whiteSpace: "nowrap" }}>{t}</span>
          {i < items.length - 1 && (
            <span style={{ width: 3, height: 3, borderRadius: "50%", background: color.accent.base, opacity: 0.8 }} />
          )}
        </span>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────── Problem */

function Problem() {
  const items = [
    { ix: "/ résumé",   t: "résumé",    p: "Written by a model, tuned for the keyword filter. A document optimized to pass, not to predict." },
    { ix: "/ portfolio", t: "portfolio", p: "Borrowed, bought, or generated overnight. You can no longer tell whose work you are looking at." },
    { ix: "/ take-home", t: "take-home", p: "Completed by the assistant, not the applicant. The artifact is real; the author is a question mark." },
  ];
  return (
    <section id="signal" style={{ padding: SECTION_PAD }}>
      <div style={WRAP_STYLE}>
        <div style={{ marginBottom: 44, maxWidth: 760 }}>
          <SectionLabel tone="eyebrow">02 — the problem</SectionLabel>
          <h2 style={sectionTitleStyle()}>
            Hiring was broken.<br />AI made it <span className="fire-text">worse</span>.
          </h2>
          <p style={leadStyle({ marginTop: 22 })}>
            Every proxy we trusted is now synthetic. You are not screening people anymore —
            you are screening prompts.
          </p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
          {items.map((it) => (
            <div key={it.t} className="card-fire-interactive" style={{
              border: `1px solid ${color.border.default}`,
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.012), rgba(255,255,255,0)), " +
                color.bg.panel,
              padding: "28px 26px 30px",
              borderRadius: radius.md,
              position: "relative",
              overflow: "hidden",
            }}>
              <span style={{ fontFamily: font.mono, fontSize: 11, color: color.text.muted, letterSpacing: "0.20em" }}>
                {it.ix}
              </span>
              <div style={{
                fontFamily: font.mono, fontWeight: 600, fontSize: "1.45rem",
                letterSpacing: "-0.02em", margin: "18px 0 12px", color: color.text.primary,
                display: "inline-block",
                position: "relative",
              }}>
                <span style={{ position: "relative", zIndex: 1 }}>{it.t}</span>
                <span style={{
                  position: "absolute", left: -2, right: -2, top: "52%", height: 2,
                  background: color.accent.ember,
                  zIndex: 0,
                }} />
              </div>
              <p style={{ color: color.text.secondary, margin: 0, fontSize: "0.97rem" }}>{it.p}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────── Thesis */

function Thesis() {
  return (
    <section style={{ padding: SECTION_PAD, borderTop: `1px solid ${color.border.default}` }}>
      <div style={WRAP_STYLE}>
        <div style={{ maxWidth: 940 }}>
          <SectionLabel tone="eyebrow">03 — the thesis</SectionLabel>
          <p style={{
            fontFamily: font.mono,
            fontWeight: 600,
            letterSpacing: "-0.045em",
            lineHeight: 1.18,
            fontSize: "clamp(1.7rem, 3.6vw, 3rem)",
            margin: "26px 0 0",
            color: color.text.primary,
            textWrap: "balance",
          }}>
            Definition of Work is evolving faster than ever.<br />
            The job is now a human <span className="fire-text">directing tools</span> — reasoning,
            delegating, judging, shipping with AI in the loop. So stop testing whether
            someone can work{" "}
            <span style={{ color: color.text.muted, textDecoration: "line-through", textDecorationColor: color.accent.ember }}>
              without
            </span>{" "}
            it. Test how they work <span className="fire-text">with</span> it, under real heat.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────── Method */

function Method() {
  const steps = [
    { n: "01", t: "The real environment", p: "IDE, AI assistant, documentation, and live business context — the same surface the role touches on day one. No whiteboard abstractions." },
    { n: "02", t: "Role-specific simulation", p: "Not puzzles. The actual work the role demands, drawn from real scenarios and scoped to 90 focused minutes." },
    { n: "03", t: "Behavioral telemetry", p: "We capture how they work — every decision, iteration, dead-end, and recovery — not just the final artifact they hand in." },
    { n: "04", t: "Multi-parameter signal", p: "Scored across the dimensions that actually predict on-the-job performance, weighted to the role you are filling." },
  ];
  return (
    <section id="method" style={{ padding: SECTION_PAD, borderTop: `1px solid ${color.border.default}` }}>
      <div style={WRAP_STYLE}>
        <div style={{ marginBottom: 44, display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap" }}>
          <div style={{ maxWidth: 620 }}>
            <SectionLabel tone="eyebrow">04 — the method</SectionLabel>
            <h2 style={sectionTitleStyle()}>
              90 minutes inside<br />the <span className="fire-text">real job</span>.
            </h2>
          </div>
          <p style={leadStyle({ maxWidth: 360 })}>
            We put candidates in the crucible — real tools, real context, real pressure — and watch
            what the heat reveals.
          </p>
        </div>
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 1,
          background: color.border.default,
          border: `1px solid ${color.border.default}`,
          borderRadius: radius.md, overflow: "hidden",
        }}>
          {steps.map((s) => (
            <div key={s.n} style={{ background: "#050403", padding: "34px 32px 38px" }}>
              <div style={{
                fontFamily: font.mono, fontSize: 12, letterSpacing: "0.20em",
                color: color.accent.amber, display: "flex", alignItems: "center", gap: 10,
              }}>
                <b style={{ color: color.text.primary, fontWeight: 600 }}>{s.n}</b> / step
              </div>
              <h3 style={{
                fontFamily: font.mono, fontWeight: 600, fontSize: "1.3rem",
                letterSpacing: "-0.02em", margin: "20px 0 12px", color: color.text.primary,
              }}>{s.t}</h3>
              <p style={{ color: color.text.secondary, margin: 0, fontSize: "0.98rem", maxWidth: "42ch" }}>{s.p}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────── Signal/Noise */

function SignalVsNoise() {
  const noise  = ["résumé keywords", "school & pedigree", "take-home polish", "interview charisma"];
  const signal = ["how they actually think", "how they wield their tools", "how they recover from failure", "what they truly ship"];
  return (
    <section style={{ padding: SECTION_PAD, borderTop: `1px solid ${color.border.default}` }}>
      <div style={WRAP_STYLE}>
        <div style={{ marginBottom: 40, maxWidth: 700 }}>
          <SectionLabel tone="eyebrow">05 — signal vs noise</SectionLabel>
          <h2 style={sectionTitleStyle()}>Burn off the noise.</h2>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          <SnCol
            title="What you screen today"
            tick="✕"
            items={noise}
            tone="noise"
          />
          <SnCol
            title="What survives the crucible"
            tick="▲"
            items={signal}
            tone="signal"
          />
        </div>
      </div>
    </section>
  );
}

function SnCol({ title, items, tick, tone }: { title: string; items: string[]; tick: string; tone: "noise" | "signal" }) {
  const isSignal = tone === "signal";
  return (
    <div style={{
      border: `1px solid ${isSignal ? "rgba(255, 150, 0, 0.35)" : color.border.default}`,
      borderRadius: radius.md,
      padding: "30px 30px 34px",
      background: isSignal
        ? "linear-gradient(180deg, rgba(255, 120, 0, 0.04), transparent)"
        : "rgba(255, 255, 255, 0.008)",
      boxShadow: isSignal ? "0 30px 80px -50px rgba(255, 106, 0, 0.45)" : undefined,
    }}>
      <h4 style={{
        fontFamily: font.mono, fontSize: 12, letterSpacing: "0.22em",
        textTransform: "uppercase", margin: "0 0 22px",
        color: isSignal ? color.accent.amber : color.text.muted,
      }}>{title}</h4>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {items.map((it, i) => (
          <li key={it} style={{
            fontFamily: font.mono, fontSize: "1.05rem", letterSpacing: "-0.01em",
            padding: "14px 0",
            borderTop: i === 0 ? "none" : `1px solid ${color.border.default}`,
            display: "flex", alignItems: "center", gap: 14,
            color: isSignal ? color.text.primary : color.text.muted,
            textDecoration: isSignal ? "none" : "line-through",
            textDecorationColor: isSignal ? undefined : "rgba(255, 61, 0, 0.6)",
          }}>
            <span style={{ fontFamily: font.mono, fontSize: 12, color: isSignal ? color.accent.base : color.text.muted }}>
              {tick}
            </span>
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────── CTA band */

function CTABand() {
  return (
    <section id="company" style={{
      position: "relative",
      textAlign: "center",
      padding: "clamp(90px, 14vw, 170px) 0",
      borderTop: `1px solid ${color.border.default}`,
      overflow: "hidden",
    }}>
      <div style={{ ...WRAP_STYLE, position: "relative", zIndex: 2 }}>
        <div style={{ display: "flex", justifyContent: "center", marginTop: -28, marginBottom: -34 }}>
          <FlameCube size={120} intensity={70} hue={26} />
        </div>
        <span style={{
          fontFamily: font.mono, fontSize: 11.5, fontWeight: 500,
          letterSpacing: "0.28em", textTransform: "uppercase",
          color: color.accent.amber, display: "inline-block",
        }}>ready when you are</span>
        <h2 style={{
          fontFamily: font.mono, fontWeight: 600,
          fontSize: "clamp(2.2rem, 6vw, 4.6rem)",
          letterSpacing: "-0.045em", lineHeight: 0.98,
          margin: "20px 0 0", color: color.text.primary,
          textWrap: "balance",
        }}>
          Put it in the <span className="fire-text">crucible</span>.
        </h2>
        <p style={leadStyle({ margin: "24px auto 0", textAlign: "center" })}>
          Run a pilot with one role. See real signal in a week — and never read another
          ghost-written résumé.
        </p>
        <div style={{ display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap", marginTop: 38 }}>
          <Link href={ASSESSMENT_HREF} style={{ textDecoration: "none" }}>
            <Button variant="primary" size="lg">Try the simulation →</Button>
          </Link>
          <a href="mailto:hello@crucible.dev" style={{ textDecoration: "none" }}>
            <Button variant="ghost" size="lg">Talk to us</Button>
          </a>
        </div>
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
          <div style={{ maxWidth: "30ch" }}>
            <Wordmark size={22} />
            <p style={{
              color: color.text.secondary, fontSize: "0.92rem",
              marginTop: 18, lineHeight: 1.65,
            }}>
              Real-work assessment simulations.<br />For today&apos;s need.
            </p>
          </div>
        </div>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          marginTop: 50, paddingTop: 26, borderTop: `1px solid ${color.border.default}`,
          gap: 16, flexWrap: "wrap",
        }}>
          <span style={{ fontFamily: font.mono, fontSize: 11.5, letterSpacing: "0.08em", color: color.text.muted }}>
            © 2026 crucible. — measure what matters.
          </span>
          <span style={{ fontFamily: font.mono, fontSize: 11.5, letterSpacing: "0.08em", color: color.text.muted }}>
            forged under pressure ▲
          </span>
        </div>
      </div>
    </footer>
  );
}

/* ─────────────────────────────────────────────────────────────── helpers */

function sectionTitleStyle(): React.CSSProperties {
  return {
    fontFamily: font.mono,
    fontWeight: 600,
    letterSpacing: "-0.04em",
    lineHeight: 1.02,
    fontSize: "clamp(2rem, 4.4vw, 3.4rem)",
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

// Reference the gradient token so the bundler doesn't complain about
// the unused import (it's available for any future use of the
// gradient.bar / gradient.fire tokens inline in this file).
void gradient;
