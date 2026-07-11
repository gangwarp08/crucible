"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { color, font, radius } from "@/styles/tokens";
import Button from "@/components/ui/Button";

// ── Orientation MAP overlay ──────────────────────────────────────────────────
//
// Replaces the old one-shot card-list tour. Dims the whole workspace with a
// semi-transparent dark backdrop (the real workspace shows through as a
// watermark) and labels every REAL region simultaneously with a short callout.
//
// Callouts are anchored to the live DOM: each region carries a `data-tour="…"`
// attribute (see Workspace.tsx + children); this overlay reads getBoundingClientRect
// for each, draws a lime highlight ring over it, and positions a label card
// nearby. It recomputes on window resize and on a short poll after mount (so
// late-mounting dynamic panels — Editor/Terminal/etc. — get measured once they
// land). Robust to a missing anchor: that region's callout is simply skipped.

/** The regions we anchor to, in the order their labels stack. `data-tour`
 *  values MUST match the attributes set in Workspace.tsx. `side` picks which
 *  edge of the region the label sits on so cards don't cover the thing they
 *  describe. */
interface RegionSpec {
  tour: string;
  title: string;
  body: string;
  side: "right" | "left" | "bottom" | "top";
}

const REGIONS: RegionSpec[] = [
  {
    tour: "files",
    title: "Files",
    body: "Your code, configs, and notes. Click any file to open it in the editor on the right.",
    side: "right",
  },
  {
    tour: "editor",
    title: "Editor",
    body: "Read and edit code here.",
    side: "top",
  },
  {
    tour: "constraints",
    title: "Live status",
    body: "Time remaining (the clock starts when you begin), tokens, and budget.",
    side: "bottom",
  },
  {
    tour: "help",
    title: "Help",
    body: "Reopen this guide anytime.",
    side: "bottom",
  },
  {
    tour: "tabs",
    title: "Your tools",
    // One callout enumerating all seven tabs (seven separate labels would
    // overlap on the narrow tab strip). Personas are scenario-driven now, so we
    // say "Client & Teammate" rather than naming anyone.
    body:
      "Brief — your instructions · Docs — company & domain documentation · Messages — real-time Client & Teammate channels · Data — the live database · Terminal · Assistant — an AI helper (counts against your budget) · Deliverable — submit your final work (submit button at the bottom).",
    side: "left",
  },
];

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function readRect(tour: string): Rect | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector(`[data-tour="${tour}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

interface Props {
  /** Whether the initial "Start working" flow applies. When true the primary
   *  button reads "Got it — Start working" and calls onStart. When false
   *  (reopened via Help after the clock is already running) it reads "Close"
   *  and only dismisses — never restarts the clock. */
  showStart: boolean;
  /** Begin the session clock (Part A). Only wired when showStart is true. */
  onStart: () => void | Promise<void>;
  /** Dismiss the overlay without starting the clock. */
  onDismiss: () => void;
}

export default function OrientationOverlay({ showStart, onStart, onDismiss }: Props): React.ReactElement {
  const [rects, setRects] = useState<Record<string, Rect | null>>({});
  const [starting, setStarting] = useState(false);
  const measuredKey = useRef("");

  // Measure every region. Called on mount, on resize, and on a short poll so
  // dynamically-imported panels that mount a beat late still get measured.
  useLayoutEffect(() => {
    let cancelled = false;
    function measure(): void {
      if (cancelled) return;
      const next: Record<string, Rect | null> = {};
      for (const r of REGIONS) next[r.tour] = readRect(r.tour);
      // Only re-render when something actually changed — avoids a render loop
      // from the poll interval when the layout is already settled.
      const key = JSON.stringify(next);
      if (key !== measuredKey.current) {
        measuredKey.current = key;
        setRects(next);
      }
    }
    measure();
    window.addEventListener("resize", measure);
    // Poll briefly (1.5s) so late-mounting dynamic panels are captured, then
    // stop — the resize listener covers everything after that.
    const poll = setInterval(measure, 250);
    const stop = setTimeout(() => clearInterval(poll), 1_500);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", measure);
      clearInterval(poll);
      clearTimeout(stop);
    };
  }, []);

  // Esc closes — but ONLY in Help mode. In pre-start mode the sole exit is the
  // "Start the simulation" button (dismissing is what starts the clock), so Esc
  // must not drop the candidate into a workspace with the clock never armed.
  useEffect(() => {
    if (showStart) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDismiss(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showStart, onDismiss]);

  async function handleStart(): Promise<void> {
    if (starting) return;
    setStarting(true);
    try {
      await onStart();
    } finally {
      // onStart owns dismissing on success; on failure we still let the
      // candidate retry, so re-enable the button.
      setStarting(false);
    }
  }

  const vw = typeof window !== "undefined" ? window.innerWidth : 1440;
  const vh = typeof window !== "undefined" ? window.innerHeight : 900;

  // Label card geometry per region — placed on the region's chosen side and
  // clamped into the viewport.
  const labels = useMemo(() => {
    const CARD_W = 240;
    const GAP = 12;
    return REGIONS.map((spec) => {
      const rect = rects[spec.tour];
      if (!rect) return null;
      let left: number;
      let top: number;
      if (spec.side === "right") {
        left = rect.left + rect.width + GAP;
        top = rect.top + Math.min(24, rect.height / 2);
      } else if (spec.side === "left") {
        left = rect.left - CARD_W - GAP;
        top = rect.top + Math.min(24, rect.height / 2);
      } else if (spec.side === "bottom") {
        left = rect.left;
        top = rect.top + rect.height + GAP;
      } else {
        // top
        left = rect.left + rect.width / 2 - CARD_W / 2;
        top = rect.top - GAP - 96;
      }
      // Clamp inside viewport with an 8px margin.
      left = Math.max(8, Math.min(left, vw - CARD_W - 8));
      top = Math.max(8, Math.min(top, vh - 120));
      return { spec, rect, left, top, width: CARD_W };
    }).filter((x): x is NonNullable<typeof x> => x !== null);
  }, [rects, vw, vh]);

  return (
    <div
      role="dialog"
      aria-label="Workspace orientation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        // Semi-transparent backdrop: the real workspace shows through as a
        // dimmed watermark. Lighter than the old blur so regions stay legible.
        background: "rgba(7, 10, 8, 0.72)",
        fontFamily: font.sans,
      }}
      // Backdrop-click dismisses ONLY in Help mode; in pre-start mode the clock
      // must be started via the button, so a stray backdrop click can't skip it.
      onClick={(e) => { if (!showStart && e.target === e.currentTarget) onDismiss(); }}
    >
      {/* Highlight rings — a lime border drawn over each real region, with a
          "hole punch" feel via an inset box-shadow that lifts the region out
          of the dim. */}
      {labels.map(({ spec, rect }) => (
        <div
          key={`ring-${spec.tour}`}
          aria-hidden
          style={{
            position: "fixed",
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            border: `1.5px solid ${color.accent.base}`,
            borderRadius: radius.md,
            boxShadow: `0 0 0 3px ${color.accent.soft}, 0 0 40px -6px ${color.accent.glow}`,
            pointerEvents: "none",
          }}
        />
      ))}

      {/* Region labels. */}
      {labels.map(({ spec, left, top, width }) => (
        <div
          key={`label-${spec.tour}`}
          style={{
            position: "fixed",
            top,
            left,
            width,
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0)), " + color.bg.panel,
            border: `1px solid ${color.border.strong}`,
            borderRadius: radius.md,
            padding: "10px 12px",
            boxShadow: "0 14px 40px -12px rgba(0,0,0,0.7)",
            pointerEvents: "none",
          }}
        >
          <div style={{
            fontFamily: font.mono,
            fontSize: 10,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: color.accent.base,
            marginBottom: 4,
          }}>
            {spec.title}
          </div>
          <div style={{ color: color.text.secondary, fontSize: 12, lineHeight: 1.5 }}>
            {spec.body}
          </div>
        </div>
      ))}

      {/* Center action panel — the identity of the overlay + the primary CTA. */}
      <div
        style={{
          position: "fixed",
          left: "50%",
          bottom: 36,
          transform: "translateX(-50%)",
          width: "min(560px, calc(100vw - 48px))",
          background:
            "linear-gradient(180deg, rgba(163,230,53,0.05), rgba(255,255,255,0)), " + color.bg.elevated,
          border: `1px solid ${color.accent.soft}`,
          borderRadius: radius.lg,
          padding: "20px 24px",
          boxShadow: "0 24px 80px -20px rgba(0,0,0,0.7)",
          textAlign: "center",
        }}
        // Clicks inside the panel must not fall through to the backdrop dismiss.
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{
          fontFamily: font.mono,
          fontSize: 10,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: color.accent.base,
          marginBottom: 8,
        }}>
          Orientation
        </div>
        <h2 style={{
          fontFamily: font.mono,
          fontSize: "1.3rem",
          fontWeight: 600,
          letterSpacing: "-0.02em",
          lineHeight: 1.15,
          margin: "0 0 8px",
          color: color.text.primary,
        }}>
          Your workspace, at a glance
        </h2>
        <p style={{
          color: color.text.secondary,
          fontSize: 12.5,
          lineHeight: 1.6,
          margin: "0 0 18px",
        }}>
          Each highlighted region has a job. {showStart
            ? "Your time starts counting the moment you begin — take a look, then start the simulation when you're ready."
            : "Press Close to return to your session."}
        </p>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
          {showStart ? (
            <Button variant="primary" size="lg" onClick={() => { void handleStart(); }} disabled={starting}>
              {starting ? "Starting…" : "Start the simulation"}
            </Button>
          ) : (
            <Button variant="primary" size="lg" onClick={onDismiss}>
              Close
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
