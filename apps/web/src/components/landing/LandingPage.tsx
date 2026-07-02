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

// Where every "Start the assessment" CTA on the landing page points. The
// catalog lists every scenario; the per-scenario start screen is one click
// further in.
const ASSESSMENT_HREF = "/scenarios";
const CONTACT_HREF = "mailto:hello@asaya.com";

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
        <Engine />
        <Simulation />
        <Signal />
        <Proof />
        <CTABand />
        <Footer />
      </div>
    </>
  );
}

/* ─────────────────────────────────────────────────────────────── Nav */

function Nav() {
  const links = [
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
        background: "rgba(4, 3, 2, 0.72)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        borderBottom: `1px solid ${color.border.default}`,
      }}
    >
      <div style={{ ...WRAP_STYLE, display: "flex", alignItems: "center", justifyContent: "space-between", height: 68 }}>
        <Wordmark size={22} />
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
          <Link href={ASSESSMENT_HREF} style={{ textDecoration: "none" }}>
            <Button variant="primary" size="md">
              Start the assessment
            </Button>
          </Link>
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
        <div style={{ maxWidth: 900 }}>
          <span style={{
            fontFamily: font.mono,
            fontSize: 11.5,
            fontWeight: 500,
            letterSpacing: "0.28em",
            textTransform: "uppercase",
            color: color.accent.amber,
            display: "inline-block",
          }}>
            dynamic work simulations · built for AI-era roles
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
            fontSize: "clamp(1rem, 1.35vw, 1.2rem)",
            lineHeight: 1.6,
            maxWidth: "60ch",
            margin: "26px auto 0",
          }}>
            The nature of work has changed — the way we assess must too. asaya. is
            simulation-based assessment for AI-era roles: a personalized sandbox that
            scores how people <em style={{ color: color.text.primary, fontStyle: "normal" }}>actually</em> work
            with AI, under real constraints.
          </p>
          <div style={{ display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap", marginTop: 36 }}>
            <Link href={ASSESSMENT_HREF} style={{ textDecoration: "none" }}>
              <Button variant="primary" size="lg">Try the simulation →</Button>
            </Link>
            <a href="#engine" style={{ textDecoration: "none" }}>
              <Button variant="ghost" size="lg">See how it works</Button>
            </a>
          </div>
          <HeroMeta />
        </div>
      </div>
    </header>
  );
}

function HeroMeta() {
  const items = ["Behavioural Telemetry™", "live-proctored", "dynamic", "evidence you can audit"];
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
  const signals = [
    { badge: "broken",       t: "Résumés",   p: "Written by a model, tuned for the keyword filter — optimized to pass, not to predict." },
    { badge: "unverifiable", t: "Portfolios", p: "AI-generated and borrowed. You can no longer tell whose work you are looking at." },
    { badge: "gamed",        t: "Interviews", p: "Half of technical candidates show AI assistance — and most of them still pass." },
  ];
  return (
    <section id="problem" style={{ padding: SECTION_PAD }}>
      <div style={WRAP_STYLE}>
        <div style={{ marginBottom: 44, maxWidth: 820 }}>
          <SectionLabel tone="eyebrow">02 — the problem</SectionLabel>
          <h2 style={sectionTitleStyle()}>
            AI-augmented engineering is exploding.<br />
            The tools to hire for it are <span className="fire-text">broken</span>.
          </h2>
          <p style={leadStyle({ marginTop: 22 })}>
            Candidates use AI to apply. Companies use AI to filter. Real talent gets lost in
            the middle — and every proxy we trusted is now synthetic.
          </p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 20 }}>
          {signals.map((it) => (
            <div key={it.t} className="card-fire-interactive" style={{
              border: `1px solid ${color.border.default}`,
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.012), rgba(255,255,255,0)), " +
                color.bg.panel,
              padding: "26px 26px 28px",
              borderRadius: radius.md,
              position: "relative",
              overflow: "hidden",
            }}>
              <span style={{
                fontFamily: font.mono, fontSize: 11, fontWeight: 700, letterSpacing: "0.18em",
                textTransform: "uppercase", color: color.accent.base,
                border: `1px solid rgba(255,106,0,0.45)`, borderRadius: 4, padding: "4px 9px",
              }}>
                {it.badge}
              </span>
              <h3 style={{
                fontFamily: font.mono, fontWeight: 600, fontSize: "1.4rem",
                letterSpacing: "-0.02em", margin: "18px 0 10px", color: color.text.primary,
              }}>{it.t}</h3>
              <p style={{ color: color.text.secondary, margin: 0, fontSize: "0.97rem", lineHeight: 1.6 }}>{it.p}</p>
            </div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20, marginTop: 20 }}>
          <StatBar n="75%" p={<>of companies report making a <b style={{ color: color.text.primary }}>bad hire this year</b> due to flawed assessment.</>} />
          <StatBar n="85%" p={<>of interview performance <b style={{ color: color.text.primary }}>doesn&apos;t correlate</b> with actual job performance.</>} />
        </div>
        <p style={{
          fontFamily: font.mono, fontSize: "clamp(1.05rem, 1.7vw, 1.4rem)", fontWeight: 600,
          letterSpacing: "-0.02em", lineHeight: 1.4, color: color.text.primary,
          borderLeft: `2px solid ${color.accent.base}`, paddingLeft: 22, margin: "40px 0 0", maxWidth: "62ch",
        }}>
          <span className="fire-text">Correctness is now a commodity.</span> A coding screen that
          bans AI tests a skill no engineer uses anymore.
        </p>
      </div>
    </section>
  );
}

function StatBar({ n, p }: { n: string; p: React.ReactNode }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 18,
      border: `1px solid rgba(255,106,0,0.30)`, background: "rgba(255,106,0,0.04)",
      borderRadius: radius.md, padding: "20px 24px",
    }}>
      <span style={{
        fontFamily: font.mono, fontWeight: 600, fontSize: "clamp(2rem, 4vw, 2.8rem)",
        letterSpacing: "-0.03em", lineHeight: 0.9, color: color.accent.base, flexShrink: 0,
      }}>{n}</span>
      <span style={{ color: color.text.secondary, fontSize: "0.95rem", lineHeight: 1.5 }}>{p}</span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────── Engine */

function Engine() {
  const steps = [
    { n: "01", t: "Tell us your stack", p: "A five-minute intake on your tools, domain, the role, and the capabilities that matter. Everything we need to build your simulation — nothing more.", tag: "~5 minutes" },
    { n: "02", t: "We generate the sandbox", p: "An intelligence engine mirrors your real environment from calibrated templates — your IDE, AI assistant, live personas, and real constraints. Personalized on the surface, fixed in difficulty." },
    { n: "03", t: "They work, we watch", p: "Behavioural Telemetry™ captures every decision, prompt, and recovery as it happens — aligned with Stanford & ETS standards. Every action scored; every score evidence-linked." },
    { n: "04", t: "Capability, measured", p: "An AI-Fluency Index™ and a full competency profile come out the other side — ranked, comparable, and fully auditable.", hot: true },
  ];
  return (
    <section id="engine" style={{ padding: SECTION_PAD, borderTop: `1px solid ${color.border.default}` }}>
      <div style={WRAP_STYLE}>
        <div style={{ marginBottom: 44, display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 28, flexWrap: "wrap" }}>
          <div style={{ maxWidth: 640 }}>
            <SectionLabel tone="eyebrow">03 — how it works</SectionLabel>
            <h2 style={sectionTitleStyle()}>
              Your environment in.<br />
              A <span className="fire-text">calibrated simulation</span> out.
            </h2>
          </div>
          <p style={leadStyle({ maxWidth: 380 })}>
            A short form on your stack and role generates a personalized work simulation —
            built and scored by assessment science to measure AI-era capability.
          </p>
        </div>
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 1,
          background: color.border.default,
          border: `1px solid ${color.border.default}`,
          borderRadius: radius.md, overflow: "hidden",
        }}>
          {steps.map((s) => (
            <div key={s.n} style={{
              background: s.hot ? "linear-gradient(180deg, rgba(255,106,0,0.06), transparent)" : "#050403",
              padding: "32px 28px 36px",
              boxShadow: s.hot ? "inset 0 0 0 1px rgba(255,106,0,0.25)" : undefined,
            }}>
              <div style={{
                fontFamily: font.mono, fontSize: 12, letterSpacing: "0.20em",
                color: color.accent.amber, display: "flex", alignItems: "center", gap: 10,
              }}>
                <b style={{ color: s.hot ? color.accent.base : color.text.primary, fontWeight: 600 }}>{s.n}</b> / step
              </div>
              <h3 style={{
                fontFamily: font.mono, fontWeight: 600, fontSize: "1.22rem",
                letterSpacing: "-0.02em", margin: "18px 0 12px",
                color: s.hot ? color.accent.base : color.text.primary,
              }}>{s.t}</h3>
              {s.tag && (
                <span style={{
                  display: "inline-block", marginBottom: 12,
                  fontFamily: font.mono, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.14em",
                  textTransform: "uppercase", color: color.accent.base,
                  border: `1px solid rgba(255,106,0,0.45)`, borderRadius: 5, padding: "5px 10px",
                }}>{s.tag}</span>
              )}
              <p style={{ color: color.text.secondary, margin: 0, fontSize: "0.95rem", lineHeight: 1.55 }}>{s.p}</p>
            </div>
          ))}
        </div>
        <p style={{
          fontFamily: font.mono, fontSize: "clamp(1.1rem, 2vw, 1.5rem)", fontWeight: 600,
          letterSpacing: "-0.02em", lineHeight: 1.35, color: color.text.primary,
          textAlign: "center", margin: "40px auto 0", maxWidth: "44ch", textWrap: "balance",
        }}>
          Personalized for fidelity. <span className="fire-text">Standardized for fairness.</span> Generated in minutes, not months.
        </p>
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────────── Simulation */

function Simulation() {
  const tiles = [
    "IDE Workspace", "AI Assistant", "Database", "Documentation",
    "Terminal", "Client Persona", "Teammate Persona", "Deliverable",
  ];
  return (
    <section id="simulation" style={{ padding: SECTION_PAD, borderTop: `1px solid ${color.border.default}` }}>
      <div style={WRAP_STYLE}>
        <div style={{ marginBottom: 44, maxWidth: 820 }}>
          <SectionLabel tone="eyebrow">04 — the simulation</SectionLabel>
          <h2 style={sectionTitleStyle()}>
            One workspace.<br />Every <span className="fire-text">real-world tool</span>.
          </h2>
          <p style={leadStyle({ marginTop: 22 })}>
            Candidates work in a real, sandboxed dev environment — not a whiteboard.
            Everything the role touches on day one is one tab away.
          </p>
        </div>
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 1,
          background: color.border.default,
          border: `1px solid ${color.border.default}`,
          borderRadius: radius.md, overflow: "hidden",
        }}>
          {tiles.map((t) => (
            <div key={t} style={{ background: "#050403", padding: "26px 24px", minHeight: 96, display: "flex", alignItems: "flex-end" }}>
              <span style={{
                fontFamily: font.mono, fontSize: 13, fontWeight: 600, letterSpacing: "0.06em",
                textTransform: "uppercase", color: color.text.secondary,
                display: "inline-flex", alignItems: "center", gap: 10,
              }}>
                <span style={{ width: 6, height: 6, background: color.accent.base, flexShrink: 0 }} />
                {t}
              </span>
            </div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 20, marginTop: 20 }}>
          <Badge tag="Live proctoring" p="Video + identity verified, end to end — so you know who actually did the work." />
          <Badge tag="Dynamic scenario engine" p="Personalized to the role's environment with progressive difficulty — never identical, impossible to leak." />
        </div>
        <div style={{
          marginTop: 20, border: `1px solid ${color.border.default}`, borderRadius: radius.md,
          padding: "18px 24px", display: "flex", gap: 16, flexWrap: "wrap",
          alignItems: "center", justifyContent: "center",
          fontFamily: font.mono, fontSize: 11.5, letterSpacing: "0.16em", textTransform: "uppercase",
          color: color.text.muted,
        }}>
          <span style={{ color: color.accent.amber, fontWeight: 600 }}>Real-world constraints</span>
          {["time", "tokens", "compute", "money", "memory"].map((c, i) => (
            <span key={c} style={{ display: "inline-flex", alignItems: "center", gap: 16 }}>
              {i > 0 && <span style={{ color: color.border.strong }}>·</span>}
              <span style={{ color: color.text.secondary }}>{c}</span>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function Badge({ tag, p }: { tag: string; p: string }) {
  return (
    <div style={{ border: `1px solid ${color.border.default}`, background: color.bg.panel, borderRadius: radius.md, padding: "24px 26px" }}>
      <span style={{
        fontFamily: font.mono, fontSize: 11, fontWeight: 700, letterSpacing: "0.20em",
        textTransform: "uppercase", color: color.accent.base,
      }}>{tag}</span>
      <p style={{ color: color.text.secondary, margin: "12px 0 0", fontSize: "0.96rem", lineHeight: 1.6 }}>{p}</p>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────── Signal */

function Signal() {
  const pillars = [
    { n: "01", t: "The Basics", s: "Core competency", items: ["Software engineering fundamentals", "Problem decomposition & structuring", "Code quality, accuracy & debugging"] },
    { n: "02", t: "The Process", s: "How they work · most important", hot: true, items: ["AI orchestration & prompt design", "Verification & judgment — knows when AI is wrong", "Adaptability when the model fails", "Stakeholder communication & product mindset"] },
    { n: "03", t: "The Outcome", s: "What gets delivered", items: ["Deliverable meets brief & constraints", "Resource efficiency — time, tokens, cost", "Stakeholder-ready output"] },
  ];
  return (
    <section id="signal" style={{ padding: SECTION_PAD, borderTop: `1px solid ${color.border.default}` }}>
      <div style={WRAP_STYLE}>
        <div style={{ marginBottom: 44, maxWidth: 820 }}>
          <SectionLabel tone="eyebrow">05 — the signal</SectionLabel>
          <h2 style={sectionTitleStyle()}>
            Every action,<br /><span className="fire-text">scored and ranked</span>.
          </h2>
          <p style={leadStyle({ marginTop: 22 })}>
            Not a pass/fail. A decision you can defend — scored on the basics, the process,
            and the outcome, with every score linked to the exact moments that earned it.
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
          {pillars.map((p) => (
            <div key={p.n} style={{
              border: `1px solid ${p.hot ? "rgba(255,106,0,0.5)" : color.border.default}`,
              background: p.hot ? "linear-gradient(180deg, rgba(255,106,0,0.05), transparent)" : color.bg.panel,
              borderRadius: radius.md, padding: "26px 26px 28px",
              boxShadow: p.hot ? "0 30px 80px -50px rgba(255,106,0,0.45)" : undefined,
            }}>
              <div style={{ fontFamily: font.mono, fontSize: 11, fontWeight: 600, letterSpacing: "0.18em", textTransform: "uppercase", color: p.hot ? color.accent.base : color.text.muted }}>
                {p.n} · {p.s}
              </div>
              <h3 style={{ fontFamily: font.mono, fontWeight: 600, fontSize: "1.5rem", letterSpacing: "-0.02em", margin: "12px 0 16px", color: p.hot ? color.accent.base : color.text.primary }}>
                {p.t}
              </h3>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                {p.items.map((it) => (
                  <li key={it} style={{ display: "flex", gap: 11, color: color.text.secondary, fontSize: "0.93rem", lineHeight: 1.5 }}>
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: p.hot ? color.accent.base : color.text.muted, marginTop: 8, flexShrink: 0 }} />
                    {it}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <FluencyIndex />
      </div>
    </section>
  );
}

function FluencyIndex() {
  const levels = [
    { t: "AI-Dependent", v: "~20", p: "Leans on AI for answers; can't tell when it's wrong.", tone: "muted" as const },
    { t: "AI-Augmented", v: "~55", p: "Directs AI well and verifies it; a reliable, productive contributor.", tone: "mid" as const },
    { t: "AI-Orchestrator", v: "~90", p: "Multiplies output, catches model failures, and knows when not to use it.", tone: "hot" as const },
  ];
  const c = (tone: "muted" | "mid" | "hot") =>
    tone === "hot" ? color.accent.base : tone === "mid" ? color.text.primary : color.text.muted;
  return (
    <div style={{
      marginTop: 20, border: `1px solid rgba(255,106,0,0.30)`, borderRadius: radius.md,
      padding: "28px 30px 30px", background: "rgba(255,106,0,0.02)",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}>
        <span style={{ fontFamily: font.mono, fontWeight: 600, fontSize: "1.4rem", letterSpacing: "-0.02em", color: color.text.primary }}>
          AI-Fluency Index<span style={{ color: color.accent.base, fontSize: "0.6em", verticalAlign: "super" }}>™</span>
        </span>
        <span style={{ fontFamily: font.mono, fontSize: 11, fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase", color: color.accent.base }}>
          not pass / fail · a calibrated spectrum
        </span>
      </div>
      {/* spectrum bar */}
      <div style={{ position: "relative", margin: "30px 0 24px" }}>
        <div style={{ height: 10, borderRadius: 6, background: "linear-gradient(90deg, #45403b 0%, #5f5346 28%, #9a6526 58%, #ff6a00 86%, #ff9500 100%)" }} />
        {[20, 55, 90].map((left, i) => (
          <span key={left} style={{
            position: "absolute", left: `${left}%`, top: "50%", transform: "translate(-50%, -50%)",
            width: i === 2 ? 14 : 10, height: i === 2 ? 14 : 10, borderRadius: "50%",
            background: i === 2 ? color.accent.base : "#1c1916",
            border: `2px solid ${i === 2 ? color.accent.hover : i === 1 ? color.accent.hover : color.text.muted}`,
          }} />
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, fontFamily: font.mono, fontSize: 10, letterSpacing: "0.12em", color: color.text.muted }}>
          <span>0</span><span>25</span><span>50</span><span>75</span><span>100</span>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 24 }}>
        {levels.map((l) => (
          <div key={l.t} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontFamily: font.mono, fontWeight: 600, fontSize: "1rem", letterSpacing: "-0.01em", color: c(l.tone) }}>{l.t}</span>
              <span style={{ fontFamily: font.mono, fontSize: 12, color: c(l.tone) }}>{l.v}</span>
            </div>
            <p style={{ color: l.tone === "hot" ? color.text.secondary : color.text.muted, fontSize: "0.9rem", lineHeight: 1.5, margin: 0 }}>{l.p}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────── Proof */

function Proof() {
  const metrics = [
    { n: "10×", l: "faster screening" },
    { n: "95%", l: "cost saving" },
    { n: "90%", l: "SME time saved" },
    { n: "40 → 4", l: "interviews per hire" },
  ];
  return (
    <section style={{ padding: SECTION_PAD, borderTop: `1px solid ${color.border.default}` }}>
      <div style={WRAP_STYLE}>
        <div style={{ marginBottom: 44, maxWidth: 820 }}>
          <SectionLabel tone="eyebrow">06 — the impact</SectionLabel>
          <h2 style={sectionTitleStyle()}>
            20 candidates. ~40 interviews.<br /><span className="fire-text">Replaced</span>.
          </h2>
          <p style={leadStyle({ marginTop: 22 })}>
            Keep the manager and SME judgment that can&apos;t be replaced. asaya. absorbs the
            broken middle — the simulations of real work that every fake signal turns into
            another interview.
          </p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 1, background: color.border.default, border: `1px solid ${color.border.default}`, borderRadius: radius.md, overflow: "hidden" }}>
          {metrics.map((m) => (
            <div key={m.l} style={{ background: "#050403", padding: "34px 28px 36px" }}>
              <div style={{ fontFamily: font.mono, fontWeight: 600, fontSize: "clamp(2rem, 4vw, 2.9rem)", letterSpacing: "-0.03em", lineHeight: 0.9, color: color.accent.base }}>{m.n}</div>
              <div style={{ fontFamily: font.mono, fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase", color: color.text.secondary, marginTop: 14 }}>{m.l}</div>
            </div>
          ))}
        </div>
        <p style={{ color: color.text.muted, fontSize: "0.95rem", lineHeight: 1.6, margin: "24px 0 0", maxWidth: "70ch" }}>
          Plus the immeasurable cost — never giving genuinely capable people a fair shot.
        </p>
      </div>
    </section>
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
          Put it through <span className="fire-text">asaya</span>.
        </h2>
        <p style={leadStyle({ margin: "24px auto 0", textAlign: "center" })}>
          Run a pilot with one role. See real signal in a week — and never read another
          ghost-written résumé.
        </p>
        <div style={{ display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap", marginTop: 38 }}>
          <Link href={ASSESSMENT_HREF} style={{ textDecoration: "none" }}>
            <Button variant="primary" size="lg">Try the simulation →</Button>
          </Link>
          <a href={CONTACT_HREF} style={{ textDecoration: "none" }}>
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
          <div style={{ maxWidth: "34ch" }}>
            <Wordmark size={22} />
            <p style={{
              color: color.text.secondary, fontSize: "0.92rem",
              marginTop: 18, lineHeight: 1.65,
            }}>
              Simulation-based assessment for AI-era roles.<br />Measure what matters.
            </p>
          </div>
          <div style={{ display: "flex", gap: 60, flexWrap: "wrap" }}>
            <FooterCol
              heading="Product"
              links={[
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
            © 2026 asaya. — measure what matters.
          </span>
          <span style={{ fontFamily: font.mono, fontSize: 11.5, letterSpacing: "0.08em", color: color.text.muted }}>
            forged under pressure ▲
          </span>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ heading, links }: { heading: string; links: { href: string; label: string }[] }) {
  return (
    <div>
      <h5 style={{
        fontFamily: font.mono, fontSize: 11, fontWeight: 500,
        letterSpacing: "0.22em", textTransform: "uppercase",
        color: color.text.muted, margin: "0 0 16px",
      }}>{heading}</h5>
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
    fontFamily: font.mono,
    fontWeight: 600,
    letterSpacing: "-0.04em",
    lineHeight: 1.05,
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
