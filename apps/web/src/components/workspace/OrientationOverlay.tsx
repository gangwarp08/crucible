"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { color, font, radius } from "@/styles/tokens";
import Button from "@/components/ui/Button";
import { useSessionStore, type ScenarioPresentation } from "@/stores/sessionStore";

// ── Orientation MAP overlay ──────────────────────────────────────────────────
//
// Dims the whole workspace to a watermark and annotates every REAL region at
// once — like a labelled diagram. Each region carries a `data-tour="…"`
// attribute (Workspace.tsx + children); we read its getBoundingClientRect,
// draw a numbered lime highlight ring over it, place a callout card in free
// space, and draw a leader ARROW from the card to the region.
//
// Cards must never overlap. We MEASURE each card's real rendered height (fonts
// can wrap unpredictably) and feed those heights into a greedy collision pass,
// so a taller card simply pushes its neighbours down instead of colliding.
// Recomputed on resize and a short post-mount poll (late dynamic panels).

interface ToolItem { name: string; desc: string }

interface RegionSpec {
  tour: string;
  title: string;
  body?: string;
  tools?: ToolItem[];
  /** Force which side of the region the callout sits on (overrides the
   *  roomier-side heuristic). Used to keep Help on the left and Live status on
   *  the right in the crowded top bar. */
  forceSide?: "left" | "right";
}

/** Region copy, grounded in the ACTUAL scenario where possible so the map
 *  names real things (customer.db, Dana, Sam) instead of generic panels —
 *  onboarding should never read like a treasure-hunt clue. Falls back to
 *  generic copy on sessions without scenario metadata. */
function buildRegions(scenario: ScenarioPresentation): RegionSpec[] {
  const tables = scenario.datasetTables;
  const clientName = scenario.clientPersona?.name;
  const teamName = scenario.teamPersona?.name;
  const people =
    clientName && teamName
      ? `One chat with ${clientName} (client) & ${teamName} (teammate)`
      : "one chat with your client & teammate";
  return [
    {
      tour: "files",
      title: "Files",
      body: tables && tables.length > 0
        ? `customer.db — a read-only copy of the data (${tables.join(", ")}) — plus a README.md that maps this whole workspace.`
        : "Your workspace files. Start with README.md — it maps everything.",
    },
    {
      tour: "editor",
      title: "Editor",
      body: "Read and edit files in the middle pane — scratch notes and query drafts welcome.",
    },
    {
      tour: "constraints",
      title: "Live status",
      body: "Time remaining, tokens, and budget. The clock starts only when you begin.",
      forceSide: "right",
    },
    {
      tour: "help",
      title: "Help",
      body: "Reopen this guide at any point during the session.",
      forceSide: "left",
    },
    {
      tour: "tabs",
      title: "Your tools",
      tools: [
        { name: "Brief", desc: "your instructions + what you have" },
        { name: "Docs", desc: "company & domain docs" },
        { name: "Messages", desc: people },
        { name: "Data", desc: tables && tables.length > 0 ? "run SQL against customer.db" : "the live database" },
        { name: "Terminal", desc: "a shell in your workspace" },
        { name: "Assistant", desc: "AI helper — uses your budget" },
        { name: "Deliverable", desc: "what to submit, and where" },
      ],
    },
  ];
}

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

const CARD_W = 264;
const GAP = 18;
const MARGIN = 14;
const RESERVED_BOTTOM = 188; // keep cards clear of the centre action panel

/** Rough first-paint height; replaced by the measured height once the card
 *  renders (see the measure effect below). */
function estimateHeight(spec: RegionSpec): number {
  if (spec.tools) return 62 + spec.tools.length * 24;
  const lines = Math.max(1, Math.ceil((spec.body?.length ?? 0) / 32));
  return 52 + lines * 20;
}

export default function OrientationOverlay({ showStart, onStart, onDismiss }: Props): React.ReactElement {
  const scenario = useSessionStore((s) => s.scenario);
  const regions = useMemo(() => buildRegions(scenario), [scenario]);
  const [rects, setRects] = useState<Record<string, Rect | null>>({});
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [starting, setStarting] = useState(false);
  const measuredKey = useRef("");

  // Measure every region rect. Poll briefly for late dynamic panels.
  useLayoutEffect(() => {
    let cancelled = false;
    function measure(): void {
      if (cancelled) return;
      const next: Record<string, Rect | null> = {};
      for (const r of regions) next[r.tour] = readRect(r.tour);
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
  }, [regions]);

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

  const placed = useMemo(() => {
    const items = regions
      .map((spec, i) => {
        const rect = rects[spec.tour];
        if (!rect) return null;
        return { spec, rect, num: i + 1, height: heights[spec.tour] ?? estimateHeight(spec) };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const boxes: Array<{
      spec: RegionSpec; rect: Rect; num: number;
      left: number; top: number; height: number; side: "left" | "right";
    }> = [];

    for (const it of items) {
      const { rect, height } = it;
      const regCx = rect.left + rect.width / 2;
      const roomRight = vw - (rect.left + rect.width);
      const preferRight = it.spec.forceSide
        ? it.spec.forceSide === "right"
        : roomRight >= CARD_W + GAP + MARGIN
          ? true
          : rect.left >= CARD_W + GAP + MARGIN
            ? false
            : regCx < vw / 2;
      let left = preferRight ? rect.left + rect.width + GAP : rect.left - CARD_W - GAP;
      let top = rect.top + rect.height / 2 - height / 2;
      left = Math.max(MARGIN, Math.min(left, vw - CARD_W - MARGIN));
      top = Math.max(MARGIN, Math.min(top, vh - height - RESERVED_BOTTOM));

      // Push straight down past any already-placed card it would overlap.
      const blocks = (t: number) => boxes.find((b) => {
        const hOverlap = left < b.left + CARD_W + GAP && left + CARD_W + GAP > b.left;
        const vOverlap = t < b.top + b.height + GAP && t + height + GAP > b.top;
        return hOverlap && vOverlap;
      });
      let guard = 0;
      let blocker = blocks(top);
      while (blocker && guard++ < 24) {
        top = blocker.top + blocker.height + GAP;
        blocker = blocks(top);
      }
      if (top + height > vh - MARGIN) top = MARGIN; // last resort: back to top

      boxes.push({ ...it, left, top, height, side: preferRight ? "left" : "right" });
    }
    return boxes;
  }, [regions, rects, heights, vw, vh]);

  // Measure the REAL rendered card heights and feed them back so the collision
  // pass reasons with truth, not an estimate. Converges in a frame or two.
  useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    const next: Record<string, number> = {};
    let changed = false;
    for (const b of placed) {
      const el = document.querySelector<HTMLElement>(`[data-orient-card="${b.spec.tour}"]`);
      if (!el) continue;
      const h = el.offsetHeight;
      next[b.spec.tour] = h;
      if (Math.abs((heights[b.spec.tour] ?? 0) - h) > 1) changed = true;
    }
    if (changed) setHeights((prev) => ({ ...prev, ...next }));
  }, [placed, heights]);

  function arrowFor(b: (typeof placed)[number]) {
    const startX = b.side === "left" ? b.left : b.left + CARD_W;
    const startY = b.top + b.height / 2;
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
        background: "rgba(7, 10, 8, 0.76)",
        fontFamily: font.sans,
      }}
      onClick={(e) => { if (!showStart && e.target === e.currentTarget) onDismiss(); }}
    >
      {/* Leader arrows. */}
      <svg aria-hidden style={{ position: "fixed", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
        <defs>
          <marker id="orient-arrow" markerWidth="10" markerHeight="10" refX="7" refY="5" orient="auto">
            <path d="M1,1 L9,5 L1,9 Z" fill={color.accent.base} />
          </marker>
        </defs>
        {placed.map((b) => {
          const { startX, startY, targetX, targetY } = arrowFor(b);
          const midX = (startX + targetX) / 2;
          const d = `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${targetY}, ${targetX} ${targetY}`;
          return (
            <path key={`arrow-${b.spec.tour}`} d={d} fill="none"
              stroke={color.accent.base} strokeWidth={1.75} strokeDasharray="5 4"
              markerEnd="url(#orient-arrow)" opacity={0.92} />
          );
        })}
      </svg>

      {/* Highlight rings + number badges. */}
      {placed.map((b) => (
        <div key={`ring-${b.spec.tour}`} aria-hidden
          style={{
            position: "fixed",
            top: b.rect.top, left: b.rect.left, width: b.rect.width, height: b.rect.height,
            border: `2px solid ${color.accent.base}`,
            borderRadius: radius.md,
            boxShadow: `0 0 0 3px ${color.accent.soft}, 0 0 44px -6px ${color.accent.glow}`,
            pointerEvents: "none",
          }}>
          <div style={badgeStyle({ top: -13, left: -13 })}>{b.num}</div>
        </div>
      ))}

      {/* Callout cards. */}
      {placed.map((b) => (
        <div key={`label-${b.spec.tour}`} data-orient-card={b.spec.tour}
          style={{
            position: "fixed", top: b.top, left: b.left, width: CARD_W,
            background: "linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0)), " + color.bg.panel,
            border: `1px solid ${color.border.strong}`,
            borderRadius: radius.md,
            padding: "14px 16px",
            boxShadow: "0 18px 48px -14px rgba(0,0,0,0.78)",
            pointerEvents: "none",
          }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: b.spec.tools ? 10 : 7 }}>
            <div style={badgeStyle({ static: true })}>{b.num}</div>
            <div style={{
              fontFamily: font.mono, fontSize: 12.5, letterSpacing: "0.12em",
              textTransform: "uppercase", color: color.accent.base, fontWeight: 600,
            }}>
              {b.spec.title}
            </div>
          </div>
          {b.spec.tools ? (
            <div style={{
              border: `1px solid ${color.border.default}`,
              borderRadius: radius.sm,
              overflow: "hidden",
            }}>
              {b.spec.tools.map((t, i) => (
                <div
                  key={t.name}
                  style={{
                    display: "flex", lineHeight: 1.3,
                    borderTop: i > 0 ? `1px solid ${color.border.default}` : "none",
                  }}
                >
                  <span style={{
                    color: color.text.primary, fontSize: 13.5, fontWeight: 600,
                    width: 96, flex: "0 0 auto",
                    padding: "6px 10px",
                    borderRight: `1px solid ${color.border.default}`,
                  }}>{t.name}</span>
                  <span style={{
                    color: color.text.secondary, fontSize: 13,
                    padding: "6px 10px",
                  }}>{t.desc}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: color.text.secondary, fontSize: 14, lineHeight: 1.55 }}>{b.spec.body}</div>
          )}
        </div>
      ))}

      {/* Centre action panel. */}
      <div
        style={{
          position: "fixed", left: "50%", bottom: 28, transform: "translateX(-50%)",
          width: "min(600px, calc(100vw - 48px))",
          background: "linear-gradient(180deg, rgba(163,230,53,0.06), rgba(255,255,255,0)), " + color.bg.elevated,
          border: `1px solid ${color.accent.soft}`,
          borderRadius: radius.lg,
          padding: "22px 28px",
          boxShadow: "0 24px 80px -20px rgba(0,0,0,0.72)",
          textAlign: "center",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{
          fontFamily: font.mono, fontSize: 11, letterSpacing: "0.2em",
          textTransform: "uppercase", color: color.accent.base, marginBottom: 10,
        }}>
          Orientation
        </div>
        <h2 style={{
          fontFamily: font.mono, fontSize: "1.6rem", fontWeight: 600,
          letterSpacing: "-0.02em", lineHeight: 1.15, margin: "0 0 10px", color: color.text.primary,
        }}>
          Your workspace, at a glance
        </h2>
        <p style={{ color: color.text.secondary, fontSize: 14.5, lineHeight: 1.6, margin: "0 0 18px" }}>
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

/** Lime number badge — used on both the ring corner and the card title. */
function badgeStyle(opts: { top?: number; left?: number; static?: boolean }): React.CSSProperties {
  return {
    ...(opts.static ? {} : { position: "absolute", top: opts.top, left: opts.left }),
    width: 23, height: 23, flex: "0 0 auto",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    background: color.accent.base, color: color.text.inverse,
    fontFamily: font.mono, fontSize: 12.5, fontWeight: 700,
    borderRadius: "50%",
    boxShadow: "0 2px 10px -1px rgba(0,0,0,0.55)",
  };
}
