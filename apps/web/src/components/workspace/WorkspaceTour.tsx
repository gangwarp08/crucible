"use client";
import { useEffect, useState } from "react";
import { color, font, radius, gradient } from "@/styles/tokens";
import Button from "@/components/ui/Button";
import SectionLabel from "@/components/ui/SectionLabel";

const STORAGE_KEY = "crucible.workspace.toured.v1";

interface TourItem {
  where: string;        // visual location anchor
  title: string;        // what the panel is
  body: string;         // one-line orientation
}

const ITEMS: TourItem[] = [
  {
    where: "Left",
    title: "File tree + editor",
    body: "Code, configs, and any notes you write live here. Click a file to open it in the editor.",
  },
  {
    where: "Right tab — Data",
    title: "Data Explorer",
    body: "Read-only SQL against the customer database. The first place to verify any hypothesis.",
  },
  {
    where: "Right tab — Messages",
    title: "Messages — Sam & Dana",
    body: "Sam (your teammate) and Dana (your client) reach you here. They may message unprompted; reply when you have something to say.",
  },
  {
    where: "Right tab — Assistant",
    title: "AI Assistant",
    body: "An AI helper for queries, debugging, or sanity-checks. Token usage counts against your scenario budget — use it to accelerate, not as a crutch.",
  },
  {
    where: "Right tab — Deliverable",
    title: "Deliverable",
    body: "Where you submit. Drafts are allowed; the latest version wins. Submitting doesn't end the session — you can keep iterating.",
  },
];

interface Props {
  /** Called when the user dismisses the tour. Parent should also set the
   *  localStorage flag (done here by default but exposed so tests can override). */
  onDismiss?: () => void;
}

/** One-shot workspace orientation overlay. Renders once per browser
 *  (gated by localStorage `crucible.workspace.toured.v1`). Mounts inside
 *  Workspace.tsx behind a guard that waits for store hydration so it doesn't
 *  flash during initial session boot. */
export default function WorkspaceTour({ onDismiss }: Props): React.ReactElement {
  const [exiting, setExiting] = useState(false);

  function dismiss(): void {
    if (typeof window !== "undefined") {
      try { window.localStorage.setItem(STORAGE_KEY, "1"); } catch { /* ignore */ }
    }
    setExiting(true);
    // small grace for the fade-out before unmounting
    setTimeout(() => onDismiss?.(), 200);
  }

  // Esc dismisses. The handler closes over the latest `onDismiss` via the
  // module-scope `dismiss` function defined above; no deps needed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") dismiss(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div
      role="dialog"
      aria-label="Workspace orientation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0, 0, 0, 0.78)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        opacity: exiting ? 0 : 1,
        transition: "opacity 200ms ease",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) dismiss(); }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 640,
          maxHeight: "calc(100vh - 48px)",
          overflowY: "auto",
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.012), rgba(255,255,255,0)), " +
            color.bg.panel,
          border: `1px solid ${color.border.strong}`,
          borderRadius: radius.md,
          boxShadow: "0 24px 80px -20px rgba(0,0,0,0.6)",
          padding: 32,
          fontFamily: font.sans,
          color: color.text.primary,
        }}
      >
        <SectionLabel tone="eyebrow">30 seconds of orientation</SectionLabel>
        <h2
          style={{
            fontFamily: font.mono,
            fontSize: "1.6rem",
            fontWeight: 600,
            letterSpacing: "-0.03em",
            lineHeight: 1.1,
            margin: "16px 0 8px",
          }}
        >
          The five surfaces you&apos;ll touch
        </h2>
        <p style={{
          color: color.text.secondary,
          fontSize: 13,
          lineHeight: 1.6,
          margin: "0 0 20px",
          maxWidth: 56 * 8,
        }}>
          Each panel has a job. Knowing where they are saves you the first ten
          minutes of hunting.
        </p>

        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          {ITEMS.map((it) => (
            <li
              key={it.title}
              style={{
                display: "grid",
                gridTemplateColumns: "150px 1fr",
                gap: 16,
                padding: "12px 14px",
                background: color.bg.elevated,
                border: `1px solid ${color.border.default}`,
                borderRadius: radius.sm,
              }}
            >
              <div style={{
                fontFamily: font.mono,
                fontSize: 11,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                color: color.accent.base,
                paddingTop: 2,
              }}>
                {it.where}
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13.5, color: color.text.primary, marginBottom: 4 }}>
                  {it.title}
                </div>
                <div style={{ color: color.text.secondary, fontSize: 12.5, lineHeight: 1.6 }}>
                  {it.body}
                </div>
              </div>
            </li>
          ))}
        </ul>

        <div style={{
          marginTop: 28,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
        }}>
          <p style={{
            color: color.text.muted,
            fontSize: 11,
            margin: 0,
            fontFamily: font.mono,
            letterSpacing: "0.04em",
          }}>
            press <kbd style={{
              fontFamily: font.mono,
              background: color.bg.input,
              border: `1px solid ${color.border.default}`,
              borderRadius: 2,
              padding: "1px 6px",
              fontSize: 11,
              color: color.text.secondary,
            }}>esc</kbd> or click outside to dismiss
          </p>
          <Button variant="primary" size="md" onClick={dismiss}>
            Got it, let&apos;s start
          </Button>
        </div>
      </div>
    </div>
  );
}

// Suppress unused-import warning for gradient (kept for future hover polish).
void gradient;

/** Read the persisted dismissal flag. Used by Workspace.tsx to decide
 *  whether to mount the tour on initial render. */
export function tourHasBeenSeen(): boolean {
  if (typeof window === "undefined") return true; // never show server-side
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return true;
  }
}
