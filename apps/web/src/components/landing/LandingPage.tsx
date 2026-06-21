"use client";
import Link from "next/link";
import { font } from "@/styles/tokens";

// ─────────────────────────────────────────────────────────────────────────
// tula. — public marketing landing page.
//
// Distilled from the investor narrative into a crisp, single-scroll page that
// applies the tula design system end to end: near-black canvas, a single vivid
// orange accent used sparingly, white headlines with orange keywords, muted
// grey body, and the warm off-white "tula." wordmark with its orange period.
//
// The "Try the simulation" CTAs route to the scenario catalog; the per-scenario
// start screen is one click further in.
// ─────────────────────────────────────────────────────────────────────────

const ASSESSMENT_HREF = "/scenarios";
const CONTACT_HREF = "mailto:hello@tula.work";

const MAXW = 1180;

// tula design palette. Kept local to the landing page — this is the public
// brand surface and deliberately diverges from the in-app fire tokens.
const C = {
  bg: "#0B0B0C",
  panel: "#101012", // dark card
  panelHi: "#141210", // warm-tinted highlighted card
  orange: "#FF5A1F",
  white: "#FFFFFF",
  grey: "#B8B8B8",
  offwhite: "#F2EDE4",
  muted: "#76747A",
  border: "#222222",
  borderHi: "rgba(255, 90, 31, 0.40)",
} as const;

const WRAP = {
  width: "100%",
  maxWidth: MAXW,
  margin: "0 auto",
  padding: "0 32px",
} as const;

const SECTION_PAD = "clamp(64px, 9vw, 120px) 0";

export default function LandingPage(): React.ReactElement {
  return (
    <div style={{ background: C.bg, color: C.white, position: "relative", overflow: "hidden" }}>
      <Glow />
      <div style={{ position: "relative", zIndex: 2 }}>
        <Nav />
        <Hero />
        <Problem />
        <WhyNow />
        <Solution />
        <Product />
        <Funnel />
        <Traction />
        <Ask />
        <CTABand />
        <Footer />
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────────────── Ambient glow */

function Glow() {
  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 0,
        pointerEvents: "none",
        background:
          "radial-gradient(90% 50% at 50% -8%, rgba(255,90,31,0.10), transparent 60%)," +
          "radial-gradient(70% 50% at 50% 118%, rgba(255,90,31,0.06), transparent 55%)",
      }}
    />
  );
}

/* ───────────────────────────────────────────────────── Wordmark */

function Tula({ size = 22, period = C.orange }: { size?: number; period?: string }) {
  return (
    <span
      style={{
        fontFamily: font.sans,
        fontWeight: 700,
        fontSize: size,
        letterSpacing: "-0.04em",
        color: C.offwhite,
        lineHeight: 1,
        display: "inline-block",
      }}
    >
      tula<span style={{ color: period }}>.</span>
    </span>
  );
}

/* ───────────────────────────────────────────────────── Eyebrow / chips */

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 11,
        fontFamily: font.mono,
        fontSize: 10.5,
        fontWeight: 500,
        letterSpacing: "0.24em",
        textTransform: "uppercase",
        color: C.muted,
      }}
    >
      <span style={{ width: 9, height: 9, background: C.orange, flex: "none" }} />
      {children}
    </span>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: font.mono,
        fontSize: 11,
        letterSpacing: "0.10em",
        textTransform: "uppercase",
        color: C.grey,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "7px 13px",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function CTAs({ size = "lg" }: { size?: "md" | "lg" }) {
  const pad = size === "lg" ? "14px 24px" : "10px 18px";
  const fs = size === "lg" ? 13 : 12;
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
      <Link href={ASSESSMENT_HREF} style={{ textDecoration: "none" }}>
        <button className="tula-primary" style={{ ...primaryBtn, padding: pad, fontSize: fs }}>
          Try the simulation →
        </button>
      </Link>
      <a href={CONTACT_HREF} style={{ textDecoration: "none" }}>
        <button className="tula-ghost" style={{ ...ghostBtn, padding: pad, fontSize: fs }}>
          Talk to us
        </button>
      </a>
    </div>
  );
}

/* ───────────────────────────────────────────────────── Nav */

function Nav() {
  return (
    <nav
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 40,
        background: "rgba(11,11,12,0.72)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        borderBottom: `1px solid ${C.border}`,
      }}
    >
      <div
        style={{
          ...WRAP,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 66,
        }}
      >
        <Tula size={22} />
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <span
            className="tula-preseed"
            style={{
              fontFamily: font.mono,
              fontSize: 10.5,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: C.muted,
            }}
          >
            Pre-seed · 2026
          </span>
          <Link href={ASSESSMENT_HREF} style={{ textDecoration: "none" }}>
            <button className="tula-primary" style={{ ...primaryBtn, padding: "9px 16px", fontSize: 12 }}>
              <span className="nav-cta-full">Try the simulation</span>
              <span className="nav-cta-short">Start</span>
            </button>
          </Link>
        </div>
      </div>
    </nav>
  );
}

/* ───────────────────────────────────────────────────── Hero */

function Hero() {
  return (
    <header
      style={{
        minHeight: "100svh",
        display: "flex",
        alignItems: "center",
        paddingTop: 66,
        position: "relative",
      }}
    >
      <div style={{ ...WRAP, textAlign: "center", padding: "72px 32px" }}>
        <Eyebrow>Dynamic work simulations · built for AI engineers</Eyebrow>

        <div style={{ marginTop: 40, lineHeight: 0.9 }}>
          <span
            style={{
              fontFamily: font.sans,
              fontWeight: 700,
              letterSpacing: "-0.05em",
              fontSize: "clamp(5rem, 18vw, 13rem)",
              color: C.offwhite,
              display: "inline-block",
            }}
          >
            tula<span style={{ color: C.orange }}>.</span>
          </span>
        </div>
        <span
          style={{
            fontFamily: font.mono,
            fontSize: "clamp(11px, 1.4vw, 13px)",
            fontWeight: 500,
            letterSpacing: "0.34em",
            textTransform: "uppercase",
            color: C.orange,
            marginTop: 18,
            display: "inline-block",
          }}
        >
          Measure what matters
        </span>

        <h1
          style={{
            fontFamily: font.sans,
            fontWeight: 700,
            fontSize: "clamp(1.7rem, 4vw, 3rem)",
            letterSpacing: "-0.03em",
            lineHeight: 1.06,
            margin: "34px auto 0",
            maxWidth: "18ch",
            textWrap: "balance",
            color: C.white,
          }}
        >
          The nature of engineering has changed.{" "}
          <span style={{ color: C.orange }}>The way we hire must too.</span>
        </h1>

        <p style={{ ...lead, margin: "24px auto 0", maxWidth: "58ch" }}>
          The simulation-based assessment for AI engineers — replacing fake signals
          with real evidence.
        </p>

        <div style={{ marginTop: 36 }}>
          <CTAs />
        </div>

        <div
          style={{
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            justifyContent: "center",
            marginTop: 40,
          }}
        >
          <Chip>Behavioural Telemetry™</Chip>
          <Chip>Live-proctored</Chip>
          <Chip>Dynamic</Chip>
        </div>
      </div>
    </header>
  );
}

/* ───────────────────────────────────────────────────── Problem */

function Problem() {
  const rows = [
    {
      tag: "Broken",
      t: "Résumés",
      p: "AI writes them. 75% of ATS rejects are actually qualified — you are filtering noise against noise.",
    },
    {
      tag: "Unverifiable",
      t: "Portfolios",
      p: "AI-generated code. You can no longer tell who built what, or whether they could build it again.",
    },
    {
      tag: "Gamed",
      t: "Interviews",
      p: "48% of technical candidates show AI assistance — and 61% of them pass anyway.",
    },
  ];
  return (
    <Section id="problem">
      <Header
        eyebrow="The problem"
        title={
          <>
            Hiring was broken.{" "}
            <span style={{ color: C.orange }}>AI made it worse.</span>
          </>
        }
        sub="Candidates use AI to apply. Companies use AI to filter. Real talent gets lost in the middle."
      />
      <div style={grid3}>
        {rows.map((r) => (
          <Card key={r.t}>
            <span style={tagStyle}>{r.tag}</span>
            <h3 style={cardTitle}>{r.t}</h3>
            <p style={cardBody}>{r.p}</p>
          </Card>
        ))}
      </div>
      <div style={{ ...statRow, marginTop: 20 }}>
        <Stat n="65%" l="of résumés are AI-generated or heavily AI-optimized" />
        <Stat n="77%" l="of recruiters meet candidates who misrepresent their skills" />
        <Stat n="85%" l="of interview performance doesn't predict job performance" />
      </div>
      <Punch>
        Correctness is now a commodity — a coding screen that bans AI tests a skill no
        engineer uses anymore.
      </Punch>
    </Section>
  );
}

/* ───────────────────────────────────────────────────── Why now */

function WhyNow() {
  const pillars = [
    {
      t: "AI Engineer",
      growth: "49K (2025) → ~80K (2026) → ~112K (2027)",
      median: "~$350k median",
      tags: ["AI Orchestrator", "Systems Architect", "Model Evaluator"],
    },
    {
      t: "Forward Deployed Engineer",
      growth: "643 (2025) → 5.3K (2026) → ~14K (2027)",
      median: "~$250k median",
      tags: ["Customer Engagement", "Product Mindset", "Builder Skills"],
    },
  ];
  return (
    <Section id="why-now" divider>
      <Header
        eyebrow="Why now"
        title={
          <>
            The AI engineer exists.{" "}
            <span style={{ color: C.orange }}>The way to assess one doesn&apos;t.</span>
          </>
        }
      />
      <Card highlight style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 18, flexWrap: "wrap" }}>
          <span style={bigStat}>71%</span>
          <span style={{ ...cardBody, maxWidth: "44ch" }}>
            of US tech postings now require AI fluency — up{" "}
            <b style={{ color: C.orange, fontWeight: 700 }}>+181% YoY</b>. The role
            arrived overnight; the assessment never did.
          </span>
        </div>
      </Card>
      <div style={grid2}>
        {pillars.map((p) => (
          <Card key={p.t}>
            <h3 style={cardTitle}>{p.t}</h3>
            <p style={{ ...mono, color: C.orange, margin: "10px 0 4px" }}>{p.growth}</p>
            <p style={{ ...cardBody, marginTop: 6 }}>{p.median} · the highest-value flavors of AI-augmented engineering.</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 18 }}>
              {p.tags.map((t) => (
                <Chip key={t}>{t}</Chip>
              ))}
            </div>
          </Card>
        ))}
      </div>
      <Punch tone="quiet">
        We go all-in on AI-engineer assessment. We expand only after we&apos;re provably
        the best at it.
      </Punch>
    </Section>
  );
}

/* ───────────────────────────────────────────────────── Solution */

function Solution() {
  const spectrum = ["AI-dependent", "AI-augmented", "AI-orchestrator"];
  const competencies = [
    "Design under Constraint",
    "Problem Framing",
    "Execution",
    "AI Orchestration",
    "Teamwork",
    "Customer Engagement",
  ];
  return (
    <Section id="solution" divider>
      <Header
        eyebrow="The solution"
        title={
          <>
            <span style={{ color: C.orange }}>Redefining</span> how we{" "}
            <span style={{ color: C.orange }}>measure capability.</span>
          </>
        }
        sub="A personalized sandbox that mimics the real culture, tools, constraints and problems of an AI-engineering role — scoring the basics, the process, the outcome, and how a candidate orchestrates AI."
      />
      <Card highlight style={{ marginBottom: 20 }}>
        <span style={tagStyle}>AI-Fluency Index™</span>
        <p style={{ ...cardBody, margin: "12px 0 20px", maxWidth: "62ch" }}>
          Not pass/fail. We place each engineer on a calibrated spectrum — catching
          model errors, knowing when <i>not</i> to use AI, and multiplying output.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          {spectrum.map((s, i) => (
            <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
              <span
                style={{
                  fontFamily: font.mono,
                  fontSize: "clamp(13px, 1.6vw, 17px)",
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                  color: i === spectrum.length - 1 ? C.orange : C.grey,
                }}
              >
                {s}
              </span>
              {i < spectrum.length - 1 && <span style={{ color: C.muted }}>→</span>}
            </span>
          ))}
        </div>
      </Card>
      <div style={grid2}>
        <Card>
          <h3 style={cardTitle}>Behavioural Telemetry™</h3>
          <p style={cardBody}>
            ~5,000 event packets per session, built on established assessment science.
            Aligned with Stanford &amp; ETS standards: fairness, comparability, validity,
            reliability.
          </p>
        </Card>
        <Card>
          <h3 style={cardTitle}>Leak-proof by design</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
            {[
              "Live video proctoring + identity verification",
              "Dynamic scenarios — never the same twice",
              "Personalized to your real stack",
            ].map((f) => (
              <span key={f} style={{ ...cardBody, display: "flex", gap: 10 }}>
                <span style={{ color: C.orange }}>▸</span>
                {f}
              </span>
            ))}
          </div>
        </Card>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 22 }}>
        {competencies.map((c) => (
          <Chip key={c}>{c}</Chip>
        ))}
        <Chip>…and more</Chip>
      </div>
    </Section>
  );
}

/* ───────────────────────────────────────────────────── Product */

function Product() {
  const tiles = [
    "IDE Workspace",
    "AI Assistant",
    "Database",
    "Documentation",
    "Terminal",
    "Client Persona",
    "Teammate Persona",
    "Deliverable",
  ];
  return (
    <Section id="product" divider>
      <Header
        eyebrow="The product · inside the simulation"
        title={
          <>
            One workspace.{" "}
            <span style={{ color: C.orange }}>Every real-world tool.</span>
          </>
        }
      />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
          gap: 1,
          background: C.border,
          border: `1px solid ${C.border}`,
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        {tiles.map((t) => (
          <div
            key={t}
            style={{
              background: C.panel,
              padding: "26px 22px",
              minHeight: 96,
              display: "flex",
              alignItems: "flex-end",
            }}
          >
            <span style={{ ...mono, color: C.grey, letterSpacing: "0.06em" }}>{t}</span>
          </div>
        ))}
      </div>
      <div style={{ ...grid2, marginTop: 20 }}>
        <Card>
          <span style={tagStyle}>Live proctoring</span>
          <p style={{ ...cardBody, marginTop: 12 }}>Video + identity verified, end to end.</p>
        </Card>
        <Card>
          <span style={tagStyle}>Dynamic scenario engine</span>
          <p style={{ ...cardBody, marginTop: 12 }}>
            Personalized to the role&apos;s real environment, never identical.
          </p>
        </Card>
      </div>
      <div
        style={{
          marginTop: 20,
          border: `1px solid ${C.border}`,
          borderRadius: 10,
          padding: "18px 24px",
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: font.mono,
          fontSize: 11.5,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: C.muted,
        }}
      >
        <span style={{ color: C.orange }}>Real-world constraints</span>
        {["Time", "Tokens", "Compute", "Money", "Memory"].map((c, i) => (
          <span key={c} style={{ display: "inline-flex", alignItems: "center", gap: 16 }}>
            {i > 0 && <span style={{ color: C.border }}>·</span>}
            <span style={{ color: C.grey }}>{c}</span>
          </span>
        ))}
      </div>
    </Section>
  );
}

/* ───────────────────────────────────────────────────── Funnel */

function Funnel() {
  return (
    <Section id="funnel" divider>
      <Header
        eyebrow="The hiring funnel"
        title={
          <>
            20 candidates. ~40 interviews.{" "}
            <span style={{ color: C.orange }}>Replaced.</span>
          </>
        }
        sub="Keep the manager and SME judgment that can't be replaced. We absorb the broken middle — the 20 simulations of real work that every fake signal turns into another interview."
      />
      <div style={statRow}>
        <Stat n="10×" l="faster screening" hi />
        <Stat n="95%" l="cost saving" />
        <Stat n="90%" l="SME time saved" />
        <Stat n="4" l="interviews, down from 40" />
      </div>
    </Section>
  );
}

/* ───────────────────────────────────────────────────── Traction */

function Traction() {
  const panels = [
    {
      tag: "Built",
      p: "MVP live end-to-end: live sandbox, AI assistant, IDE, Behavioural Telemetry™, live proctoring, AI-Fluency Index, evidence-backed scoring.",
    },
    {
      tag: "Validated",
      p: "25 FDE sims run; scoring shows early discriminant validity — it separates strong from weak. Scaling 25 → 100+ to harden the model.",
    },
    {
      tag: "Demand",
      p: "Two pilots signed (LOI): a talent-matching agency + an AI boutique consulting firm — our exact channel partners. More in pipeline.",
    },
  ];
  return (
    <Section id="traction" divider>
      <Header
        eyebrow="Traction · early proof"
        title={
          <>
            25 sims in. Two LOIs signed.{" "}
            <span style={{ color: C.orange }}>The signal is real.</span>
          </>
        }
      />
      <div style={grid3}>
        {panels.map((p, i) => (
          <Card key={p.tag} highlight={i === 2}>
            <span style={tagStyle}>{p.tag}</span>
            <p style={{ ...cardBody, marginTop: 12 }}>{p.p}</p>
          </Card>
        ))}
      </div>
      <Punch tone="quiet">
        Every run compounds proprietary &ldquo;good-work&rdquo; data — the start of the moat.
      </Punch>
    </Section>
  );
}

/* ───────────────────────────────────────────────────── Ask */

function Ask() {
  const milestones = [
    { t: "it works", p: "AI-engineer validity demonstrated — scores correlate with real performance (25 → 100+ sims)." },
    { t: "they buy", p: "Channel proven repeatable — 2 signed LOIs → ~10 partners, $2M+ ARR run-rate." },
    { t: "it scales", p: "Integrity + IP shipped to production; unit economics confirmed." },
  ];
  return (
    <Section id="ask" divider>
      <Header
        eyebrow="The ask & the horizon"
        title={
          <>
            Build the wedge.{" "}
            <span style={{ color: C.orange }}>Then the layer.</span>
          </>
        }
      />
      <Card highlight style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 18, flexWrap: "wrap" }}>
          <span style={bigStat}>$1.5M</span>
          <span style={{ ...cardBody, maxWidth: "40ch" }}>
            Pre-Seed (~8%) · ~12-month runway to prove AI-engineer validity, a repeatable
            channel, and shipped integrity IP.
          </span>
        </div>
      </Card>
      <div style={grid3}>
        {milestones.map((m, i) => (
          <Card key={m.t}>
            <span style={{ ...mono, color: C.orange }}>0{i + 1} / {m.t}</span>
            <p style={{ ...cardBody, marginTop: 12 }}>{m.p}</p>
          </Card>
        ))}
      </div>
    </Section>
  );
}

/* ───────────────────────────────────────────────────── CTA band */

function CTABand() {
  return (
    <section
      style={{
        textAlign: "center",
        padding: "clamp(80px, 12vw, 150px) 0",
        borderTop: `1px solid ${C.border}`,
      }}
    >
      <div style={{ ...WRAP, textAlign: "center" }}>
        <Eyebrow>Ready when you are</Eyebrow>
        <h2
          style={{
            fontFamily: font.sans,
            fontWeight: 700,
            fontSize: "clamp(2.2rem, 6vw, 4.4rem)",
            letterSpacing: "-0.04em",
            lineHeight: 1.0,
            margin: "26px auto 0",
            maxWidth: "20ch",
            textWrap: "balance",
            color: C.white,
          }}
        >
          Stop screening prompts.{" "}
          <span style={{ color: C.orange }}>Start measuring engineers.</span>
        </h2>
        <p style={{ ...lead, margin: "24px auto 0", textAlign: "center" }}>
          Run a pilot with one role. See real signal in a week — and never read another
          ghost-written résumé.
        </p>
        <div style={{ marginTop: 36 }}>
          <CTAs />
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────── Footer */

function Footer() {
  return (
    <footer style={{ borderTop: `1px solid ${C.border}`, padding: "52px 0 40px" }}>
      <div style={WRAP}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 30,
            flexWrap: "wrap",
          }}
        >
          <div style={{ maxWidth: "32ch" }}>
            <Tula size={22} />
            <p style={{ ...cardBody, marginTop: 16 }}>
              The simulation-based assessment for AI engineers. Measure what matters.
            </p>
          </div>
          <span
            style={{
              fontFamily: font.mono,
              fontSize: 10.5,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: C.muted,
            }}
          >
            Pre-seed · 2026
          </span>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 44,
            paddingTop: 24,
            borderTop: `1px solid ${C.border}`,
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <span style={{ ...mono, color: C.muted, letterSpacing: "0.08em" }}>
            © 2026 tula. — measure what matters
          </span>
          <span style={{ ...mono, color: C.muted, letterSpacing: "0.08em" }}>
            Behavioural Telemetry™ · Live-proctored · Dynamic
          </span>
        </div>
      </div>
    </footer>
  );
}

/* ───────────────────────────────────────────────────── Layout primitives */

function Section({
  id,
  divider,
  children,
}: {
  id?: string;
  divider?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      style={{
        padding: SECTION_PAD,
        borderTop: divider ? `1px solid ${C.border}` : undefined,
      }}
    >
      <div style={WRAP}>{children}</div>
    </section>
  );
}

function Header({
  eyebrow,
  title,
  sub,
}: {
  eyebrow: string;
  title: React.ReactNode;
  sub?: string;
}) {
  return (
    <div style={{ marginBottom: 40, maxWidth: 820 }}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2
        style={{
          fontFamily: font.sans,
          fontWeight: 700,
          fontSize: "clamp(1.9rem, 4.2vw, 3.2rem)",
          letterSpacing: "-0.035em",
          lineHeight: 1.04,
          margin: "20px 0 0",
          textWrap: "balance",
          color: C.white,
        }}
      >
        {title}
      </h2>
      {sub && <p style={{ ...lead, marginTop: 20 }}>{sub}</p>}
    </div>
  );
}

function Card({
  children,
  highlight,
  style,
}: {
  children: React.ReactNode;
  highlight?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        border: `1px solid ${highlight ? C.borderHi : C.border}`,
        background: highlight ? C.panelHi : C.panel,
        borderRadius: 12,
        padding: "26px 26px 28px",
        boxShadow: highlight ? "0 30px 80px -50px rgba(255,90,31,0.5)" : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Stat({ n, l, hi }: { n: string; l: string; hi?: boolean }) {
  return (
    <div
      style={{
        border: `1px solid ${hi ? C.borderHi : C.border}`,
        background: hi ? C.panelHi : C.panel,
        borderRadius: 12,
        padding: "24px 24px 26px",
      }}
    >
      <div
        style={{
          fontFamily: font.sans,
          fontWeight: 700,
          fontSize: "clamp(2rem, 4vw, 2.9rem)",
          letterSpacing: "-0.04em",
          lineHeight: 1,
          color: C.orange,
        }}
      >
        {n}
      </div>
      <p style={{ ...cardBody, marginTop: 12, fontSize: "0.9rem" }}>{l}</p>
    </div>
  );
}

function Punch({
  children,
  tone = "loud",
}: {
  children: React.ReactNode;
  tone?: "loud" | "quiet";
}) {
  const loud = tone === "loud";
  return (
    <p
      style={{
        fontFamily: font.sans,
        fontWeight: loud ? 600 : 500,
        fontSize: loud ? "clamp(1.1rem, 2vw, 1.5rem)" : "clamp(1rem, 1.6vw, 1.2rem)",
        letterSpacing: "-0.02em",
        lineHeight: 1.4,
        margin: "32px 0 0",
        maxWidth: "62ch",
        color: loud ? C.white : C.grey,
        borderLeft: `2px solid ${C.orange}`,
        paddingLeft: 20,
      }}
    >
      {children}
    </p>
  );
}

/* ───────────────────────────────────────────────────── Shared styles */

const lead: React.CSSProperties = {
  fontFamily: font.sans,
  color: C.grey,
  fontSize: "clamp(1rem, 1.3vw, 1.15rem)",
  lineHeight: 1.6,
  maxWidth: "60ch",
  margin: 0,
};

const mono: React.CSSProperties = {
  fontFamily: font.mono,
  fontSize: 12,
  letterSpacing: "0.04em",
};

const cardBody: React.CSSProperties = {
  fontFamily: font.sans,
  color: C.grey,
  fontSize: "0.98rem",
  lineHeight: 1.6,
  margin: 0,
};

const cardTitle: React.CSSProperties = {
  fontFamily: font.sans,
  fontWeight: 700,
  fontSize: "1.3rem",
  letterSpacing: "-0.02em",
  margin: "16px 0 10px",
  color: C.white,
};

const tagStyle: React.CSSProperties = {
  fontFamily: font.mono,
  fontSize: 10.5,
  fontWeight: 500,
  letterSpacing: "0.22em",
  textTransform: "uppercase",
  color: C.orange,
};

const bigStat: React.CSSProperties = {
  fontFamily: font.sans,
  fontWeight: 700,
  fontSize: "clamp(3rem, 7vw, 5rem)",
  letterSpacing: "-0.05em",
  lineHeight: 0.9,
  color: C.orange,
};

const grid3: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
  gap: 16,
};

const grid2: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
  gap: 16,
};

const statRow: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 16,
};

const primaryBtn: React.CSSProperties = {
  fontFamily: font.mono,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  fontSize: 12,
  color: "#0B0B0C",
  background: C.orange,
  border: "1px solid transparent",
  borderRadius: 8,
  cursor: "pointer",
  whiteSpace: "nowrap",
  lineHeight: 1,
};

const ghostBtn: React.CSSProperties = {
  fontFamily: font.mono,
  fontWeight: 500,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  fontSize: 12,
  color: C.offwhite,
  background: "transparent",
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  cursor: "pointer",
  whiteSpace: "nowrap",
  lineHeight: 1,
};
