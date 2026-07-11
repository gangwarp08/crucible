"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { color, font, radius } from "@/styles/tokens";
import Button from "@/components/ui/Button";

// ── Orientation MAP overlay ──────────────────────────────────────────────────
//
// Dims the whole workspace to a watermark and annotates every REAL region at
// once — like a labelled diagram. Each region carries a `data-tour="…"`
// attribute (Workspace.tsx + children); we read its getBoundingClientRect,
// draw a numbered lime highlight ring over it, place a callout card in free
// space, and draw a leader ARROW from the card to the region. A collision pass
// nudges cards apart so no two callouts (titles) ever overlap. Recomputed on
// resize and a short post-mount poll (late dynamic panels). A missing anchor is
// simply skipped.

interface ToolItem { name: string; desc: string }

interface RegionSpec {
  tour: string;
  title: string;
  /** Prose body — used for every region except the tab strip. */
  body?: string;
  /** The tab strip enumerates its tools as distinct rows instead of prose. */
  tools?: ToolItem[];
}

const REGIONS: RegionSpec[] = [
  {
    tour: "files",
    title: "Files",
    body: "Your code, configs, and notes. Click any file to open it in the editor.",
  },
  {
    tour: "editor",
    title: "Editor",
    body: "Read and edit code in the middle pane.",
  },
  {
    tour: "constraints",
    title: "Live status",
    body: "Time remaining, tokens, and budget. The clock starts only when you begin.",
  },
  {
    tour: "help",
    title: "Help",
    body: "Reopen this guide at any point during the session.",
  },
  {
    tour: "tabs",
    title: "Your tools",
    tools: [
      { name: "Brief", desc: "your instructions" },
      { name: "Docs", desc: "company & domain documentation" },
      { name: "Messages", desc: "real-time Client & Teammate channels" },
      { name: "Data", desc: "the live database" },
      { name: "Terminal", desc: "a shell in your workspace" },
      { name: "Assistant", desc: "an AI helper — counts against your budget" },
      { name: "Deliverable", desc: "submit your final work" },
    ],
  },
];

interface Rect { top: number; left: number; width: number; height: number }

function readRect(tour: string): Rect | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector(`[data-tour="${tour}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

interface Props {
  showStart: boolean;
  onStart: () => void | Promise<void>;
  onDismiss: () => void;
}

const CARD_W = 236;
const GAP = 16;
const MARGIN = 12;
const RESERVED_BOTTOM = 176; // keep cards clear of the centre action panel

/** Rough card height so the collision pass can reason about boxes before the
 *  DOM lays them out. Tuned to the padding + line-height below. */
function estimateHeight(spec: RegionSpec): number {
  const head = 40;
  if (spec.tools) return head + spec.tools.length * 20 + 8;
  const chars = spec.body?.length ?? 0;
  const lines = Math.max(1, Math.ceil(chars / 34));
  return head + lines * 17 + 6;
}

export default function OrientationOverlay({ showStart, onStart, onDismiss }: Props): React.ReactElement {
  const [rects, setRects] = useState<Record<string, Rect | null>>({});
  const [starting, setStarting] = useState(false);
  const measuredKey = useRef("");

  useLayoutEffect(() => {
    let cancelled = false;
    function measure(): void {
      if (cancelled) return;
      const next: Record<string, Rect | null> = {};
      for (const r of REGIONS) next[r.tour] = readRect(r.tour);
      const key = JSON.stringify(next);
      if (key !== measuredKey.current) {
        measuredKey.current = key;
        setRects(next);
      }
    }
    measure();
    window.addEventListener("resize", measure);
    const poll = setInterval(measure, 250);
    const stop = setTimeout(() => clearInterval(poll), 1_500);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", measure);
      clearInterval(poll);
      clearTimeout(stop);
    };
  }, []);

  useEffect(() => {
    if (showStart) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onDismiss(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showStart, onDismiss]);

  async function handleStart(): Promise<void> {
    if (starting) return;
    setStarting(true);
    try { await onStart(); } finally { setStarting(false); }
  }

  const vw = typeof window !== "undefined" ? window.innerWidth : 1440;
  const vh = typeof window !== "undefined" ? window.innerHeight : 900;

  // Place every callout card so (1) it sits beside its region on the side that
  // has the most room, (2) it stays inside the viewport, and (3) no two cards
  // overlap — a greedy vertical de-collision pass. Each placed card records the
  // point its leader arrow should originate from and the region point it aims at.
  const placed = useMemo(() => {
    const items = REGIONS
      .map((spec, i) => {
        const rect = rects[spec.tour];
        if (!rect) return null;
        return { spec, rect, num: i + 1, height: estimateHeight(spec) };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const boxes: Array<{
      spec: RegionSpec; rect: Rect; num: number;
      left: number; top: number; height: number;
      side: "left" | "right"; // which edge of the card the arrow leaves from
    }> = [];

    for (const it of items) {
      const { rect } = it;
      const regCx = rect.left + rect.width / 2;
      // Prefer the side of the region with more horizontal room for the card.
      const roomRight = vw - (rect.left + rect.width);
      const preferRight = roomRight >= CARD_W + GAP + MARGIN
        ? true
        : rect.left >= CARD_W + GAP + MARGIN
          ? false
          : regCx < vw / 2; // neither side fits cleanly: fall to the roomier half
      let left = preferRight
        ? rect.left + rect.width + GAP
        : rect.left - CARD_W - GAP;
      // Vertically align the card's centre with the region's, then clamp.
      let top = rect.top + rect.height / 2 - it.height / 2;
      left = Math.max(MARGIN, Math.min(left, vw - CARD_W - MARGIN));
      top = Math.max(MARGIN, Math.min(top, vh - it.height - RESERVED_BOTTOM));

      // De-collide against everything already placed: if this card's box would
      // overlap a placed one, push it straight down past it. Repeat until clear.
      const overlaps = (aT: number) => boxes.some((b) => {
        const hOverlap = left < b.left + CARD_W + GAP && left + CARD_W + GAP > b.left;
        const vOverlap = aT < b.top + b.height + GAP && aT + it.height + GAP > b.top;
        return hOverlap && vOverlap;
      });
      let guard = 0;
      while (overlaps(top) && guard++ < 24) {
        const blocker = boxes.find((b) => {
          const hOverlap = left < b.left + CARD_W + GAP && left + CARD_W + GAP > b.left;
          const vOverlap = top < b.top + b.height + GAP && top + it.height + GAP > b.top;
          return hOverlap && vOverlap;
        });
        if (!blocker) break;
        top = blocker.top + blocker.height + GAP;
      }
      // If pushed off the bottom, wrap back up near the top margin.
      if (top + it.height > vh - MARGIN) top = MARGIN;

      boxes.push({ ...it, left, top, side: preferRight ? "left" : "right" });
    }
    return boxes;
  }, [rects, vw, vh]);

  // Arrow geometry: from the card's inner edge to the nearest edge of its region.
  function arrowFor(b: (typeof placed)[number]) {
    const cardMidY = b.top + b.height / 2;
    // Card origin: the edge that faces the region.
    const startX = b.side === "left" ? b.left : b.left + CARD_W;
    const startY = cardMidY;
    // Region target: nearest vertical edge, clamped to the region's height.
    const targetX = b.side === "left" ? b.rect.left + b.rect.width : b.rect.left;
    const targetY = Math.max(b.rect.top + 10, Math.min(startY, b.rect.top + b.rect.height - 10));
    return { startX, startY, targetX, targetY };
  }

  return (
    <div
      role="dialog"
      aria-label="Workspace orientation"
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(7, 10, 8, 0.74)",
        fontFamily: font.sans,
      }}
      onClick={(e) => { if (!showStart && e.target === e.currentTarget) onDismiss(); }}
    >
      {/* Leader arrows (one SVG layer under the cards). */}
      <svg
        aria-hidden
        style={{ position: "fixed", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
      >
        <defs>
          <marker id="orient-arrow" markerWidth="9" markerHeight="9" refX="6.5" refY="4.5" orient="auto">
            <path d="M1,1 L8,4.5 L1,8 Z" fill={color.accent.base} />
          </marker>
        </defs>
        {placed.map((b) => {
          const { startX, startY, targetX, targetY } = arrowFor(b);
          // A gentle horizontal-first elbow reads cleaner than a raw diagonal.
          const midX = (startX + targetX) / 2;
          const d = `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${targetY}, ${targetX} ${targetY}`;
          return (
            <path
              key={`arrow-${b.spec.tour}`}
              d={d}
              fill="none"
              stroke={color.accent.base}
              strokeWidth={1.5}
              strokeDasharray="4 4"
              markerEnd="url(#orient-arrow)"
              opacity={0.9}
            />
          );
        })}
      </svg>

      {/* Highlight rings + number badges. */}
      {placed.map((b) => (
        <div
          key={`ring-${b.spec.tour}`}
          aria-hidden
          style={{
            position: "fixed",
            top: b.rect.top, left: b.rect.left, width: b.rect.width, height: b.rect.height,
            border: `1.5px solid ${color.accent.base}`,
            borderRadius: radius.md,
            boxShadow: `0 0 0 3px ${color.accent.soft}, 0 0 40px -6px ${color.accent.glow}`,
            pointerEvents: "none",
          }}
        >
          <div style={badgeStyle({ top: -11, left: -11 })}>{b.num}</div>
        </div>
      ))}

      {/* Callout cards. */}
      {placed.map((b) => (
        <div
          key={`label-${b.spec.tour}`}
          style={{
            position: "fixed", top: b.top, left: b.left, width: CARD_W,
            background: "linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0)), " + color.bg.panel,
            border: `1px solid ${color.border.strong}`,
            borderRadius: radius.md,
            padding: "11px 13px",
            boxShadow: "0 16px 44px -14px rgba(0,0,0,0.75)",
            pointerEvents: "none",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: b.spec.tools ? 8 : 5 }}>
            <div style={badgeStyle({ static: true })}>{b.num}</div>
            <div style={{
              fontFamily: font.mono, fontSize: 10, letterSpacing: "0.16em",
              textTransform: "uppercase", color: color.accent.base,
            }}>
              {b.spec.title}
            </div>
          </div>
          {b.spec.tools ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {b.spec.tools.map((t) => (
                <div key={t.name} style={{ display: "flex", gap: 6, alignItems: "baseline", lineHeight: 1.35 }}>
                  <span style={{ color: color.text.primary, fontSize: 12, fontWeight: 600, minWidth: 74 }}>{t.name}</span>
                  <span style={{ color: color.text.secondary, fontSize: 11.5 }}>{t.desc}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: color.text.secondary, fontSize: 12, lineHeight: 1.5 }}>{b.spec.body}</div>
          )}
        </div>
      ))}

      {/* Centre action panel. */}
      <div
        style={{
          position: "fixed", left: "50%", bottom: 28, transform: "translateX(-50%)",
          width: "min(560px, calc(100vw - 48px))",
          background: "linear-gradient(180deg, rgba(163,230,53,0.05), rgba(255,255,255,0)), " + color.bg.elevated,
          border: `1px solid ${color.accent.soft}`,
          borderRadius: radius.lg,
          padding: "18px 24px",
          boxShadow: "0 24px 80px -20px rgba(0,0,0,0.7)",
          textAlign: "center",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{
          fontFamily: font.mono, fontSize: 10, letterSpacing: "0.18em",
          textTransform: "uppercase", color: color.accent.base, marginBottom: 8,
        }}>
          Orientation
        </div>
        <h2 style={{
          fontFamily: font.mono, fontSize: "1.3rem", fontWeight: 600,
          letterSpacing: "-0.02em", lineHeight: 1.15, margin: "0 0 8px", color: color.text.primary,
        }}>
          Your workspace, at a glance
        </h2>
        <p style={{ color: color.text.secondary, fontSize: 12.5, lineHeight: 1.6, margin: "0 0 16px" }}>
          Each numbered region has a job — the arrows point to where it lives. {showStart
            ? "Your time only starts when you begin, so look around first."
            : "Press Close to return to your session."}
        </p>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
          {showStart ? (
            <Button variant="primary" size="lg" onClick={() => { void handleStart(); }} disabled={starting}>
              {starting ? "Starting…" : "Start the simulation"}
            </Button>
          ) : (
            <Button variant="primary" size="lg" onClick={onDismiss}>Close</Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Small lime number badge — used on both the ring corner and the card title. */
function badgeStyle(opts: { top?: number; left?: number; static?: boolean }): React.CSSProperties {
  return {
    ...(opts.static
      ? {}
      : { position: "absolute", top: opts.top, left: opts.left }),
    width: 20, height: 20, flex: "0 0 auto",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    background: color.accent.base, color: color.text.inverse,
    fontFamily: font.mono, fontSize: 11, fontWeight: 700,
    borderRadius: "50%",
    boxShadow: "0 2px 8px -1px rgba(0,0,0,0.5)",
  };
}
