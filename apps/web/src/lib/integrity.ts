"use client";
// Passive browser-side integrity detectors (Proctoring v1, slice P1.1).
//
// Philosophy: informational signal channel only — these events are shown to
// reviewers as context and NEVER feed competency scoring (isolation is
// enforced server-side; see services/evidence-extractor.ts which whitelists
// event types). Telemetry never throws and never blocks the candidate: every
// failure path here is swallowed, and when the server predates the
// POST /sessions/:id/integrity route the batches simply 404 into the void.
import { useEffect, useRef } from "react";
import { postIntegrityEvents, type IntegrityEventInput } from "@/lib/api";

// ── Thresholds (defaults per v-next spec; calibrate on cohort 1) ─────────────
const PASTE_BURST_CHARS = 400;     // paste larger than this → integrity.paste_burst
const IDLE_GAP_MS = 120_000;       // no keydown/mousemove for longer → integrity.idle_gap
const BLUR_FOCUS_IGNORE_MS = 300;  // blur→focus pairs faster than this are noise (drop both)
const DEVTOOLS_DELTA_PX = 200;     // outer-inner window size delta heuristic (best-effort)

// ── Client-side debounce/caps (server re-validates; never trust client volume)
const FLUSH_INTERVAL_MS = 5_000;   // POST at most every 5s
const MAX_BATCH = 20;              // max events per POST
const MAX_QUEUE = 30;              // drop beyond this many queued

type PanelKind = "editor" | "chat" | "message" | "other";

/** Best-effort panel classification for paste targets. Reads the
 *  `data-integrity-panel` markers on the Workspace pane wrappers, with a
 *  Monaco-class fallback for the editor (its textarea lives deep inside). */
function classifyPanel(target: EventTarget | null): PanelKind {
  const el =
    target instanceof Element ? target
    : target instanceof Node ? target.parentElement
    : null;
  if (!el) return "other";
  const panel = el.closest("[data-integrity-panel]")?.getAttribute("data-integrity-panel");
  if (panel === "editor" || panel === "chat" || panel === "message") return panel;
  if (el.closest(".monaco-editor")) return "editor";
  return "other";
}

/** Panel the current selection sits in — used to attribute copy events to the
 *  read-only source panels (docs / brief). Returns null for anywhere else. */
function selectionSource(sel: Selection): "docs" | "brief" | null {
  const node = sel.anchorNode;
  const el =
    node instanceof Element ? node
    : node instanceof Node ? node.parentElement
    : null;
  const panel = el?.closest("[data-integrity-panel]")?.getAttribute("data-integrity-panel");
  return panel === "docs" || panel === "brief" ? panel : null;
}

/** Passive integrity monitor. Installs document/window listeners while
 *  `enabled` and batches events to POST /sessions/:id/integrity. Everything is
 *  fire-and-forget; all listeners are removed on unmount / disable. */
export function useIntegrityMonitor(sessionId: string, enabled: boolean): void {
  // Survives enable/disable cycles so devtools is emitted at most once per
  // mounted workspace even if the session flips active → locked → active.
  const devtoolsSeenRef = useRef(false);
  // Same once-per-mounted-workspace latch for the session-start client_env
  // snapshot (geo/network slice).
  const clientEnvSentRef = useRef(false);

  useEffect(() => {
    if (!enabled || !sessionId || typeof window === "undefined") return;

    const queue: IntegrityEventInput[] = [];
    // Shape mirrors the shared IntegrityEventSchema exactly: epoch-ms client
    // ts, and NO payload key for signal-only events (their schema is a strict
    // empty object — extra keys would fail validation server-side).
    const enqueue = (type: string, payload?: Record<string, unknown>): void => {
      if (queue.length >= MAX_QUEUE) return; // cap; server re-validates anyway
      queue.push({ type, ts: Date.now(), ...(payload !== undefined ? { payload } : {}) });
    };

    const flush = (): void => {
      if (queue.length === 0) return;
      const batch = queue.splice(0, MAX_BATCH);
      void postIntegrityEvents(sessionId, batch); // never throws
    };

    // ── Client environment snapshot (geo/network slice) — emitted ONCE ──────
    // The browser's own timezone, cross-checked server-side against the
    // IP-derived country (informational only, like every signal here). Any
    // Intl failure degrades to tz_name: null — never blocks the candidate.
    if (!clientEnvSentRef.current) {
      clientEnvSentRef.current = true;
      let tzName: string | null = null;
      try {
        // `|| null` also catches a hypothetical empty string (schema: min 1).
        tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
      } catch {
        tzName = null;
      }
      enqueue("integrity.client_env", {
        tz_offset_minutes: Math.round(new Date().getTimezoneOffset()),
        tz_name: tzName,
      });
    }

    // ── Blur/focus with sub-300ms noise suppression ──────────────────────────
    // A blur is only committed after BLUR_FOCUS_IGNORE_MS; a focus arriving
    // before the commit cancels the pair entirely (palette popups, brief
    // OS focus flickers).
    function makeBlurTracker(
      blurType: string,
      focusType: string | null,
      suppress?: () => boolean,
    ) {
      let blurAt: number | null = null;
      let timer: number | null = null;
      let committed = false;
      return {
        blur(): void {
          if (blurAt !== null) return; // already blurred
          blurAt = Date.now();
          committed = false;
          timer = window.setTimeout(() => {
            committed = true;
            if (!suppress?.()) enqueue(blurType);
          }, BLUR_FOCUS_IGNORE_MS);
        },
        focus(): void {
          if (blurAt === null) return;
          if (timer !== null) window.clearTimeout(timer);
          // Signal-only event: away duration is recoverable from the
          // blur/focus event pair's timestamps, so no payload here (the
          // shared schema is strict-empty for focus).
          if (committed && focusType !== null) enqueue(focusType);
          blurAt = null;
          timer = null;
          committed = false;
        },
        dispose(): void {
          if (timer !== null) window.clearTimeout(timer);
        },
      };
    }

    const tabTracker = makeBlurTracker("integrity.tab_blur", "integrity.tab_focus");
    // window_blur means "app switched away with the tab still visible" (e.g.
    // alt-tab to another program). When the tab itself is hidden, tab_blur
    // already covers it — suppress the window_blur so a plain tab switch
    // doesn't double-count as two blur events. Checked at commit time (300ms
    // after the blur) so the blur/visibilitychange firing order is irrelevant.
    const windowTracker = makeBlurTracker(
      "integrity.window_blur",
      null,
      () => document.visibilityState === "hidden",
    );

    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") tabTracker.blur();
      else tabTracker.focus();
    };
    const onWindowBlur = (): void => { windowTracker.blur(); };
    const onWindowFocus = (): void => { windowTracker.focus(); };

    // ── Idle gap: emitted on activity RESUME, carrying the gap length ────────
    let lastActivity = Date.now();
    const onActivity = (): void => {
      const now = Date.now();
      const gap = now - lastActivity;
      lastActivity = now;
      if (gap > IDLE_GAP_MS) enqueue("integrity.idle_gap", { ms: gap });
    };

    // ── Paste bursts ─────────────────────────────────────────────────────────
    const onPaste = (e: ClipboardEvent): void => {
      const text = e.clipboardData?.getData("text") ?? "";
      if (text.length > PASTE_BURST_CHARS) {
        enqueue("integrity.paste_burst", {
          chars: Math.min(text.length, 1_000_000), // schema ceiling
          target: classifyPanel(e.target),
        });
      }
    };

    // ── Copy from the read-only source panels (docs / brief) ─────────────────
    const onCopy = (): void => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const chars = sel.toString().length;
      if (chars === 0) return; // schema requires chars >= 1
      const source = selectionSource(sel);
      if (source !== null) {
        enqueue("integrity.copy", { source, chars: Math.min(chars, 1_000_000) });
      }
    };

    // ── Devtools (best-effort heuristic; emitted once; don't over-weight) ────
    const checkDevtools = (): void => {
      if (devtoolsSeenRef.current) return;
      const dw = window.outerWidth - window.innerWidth;
      const dh = window.outerHeight - window.innerHeight;
      if (dw > DEVTOOLS_DELTA_PX || dh > DEVTOOLS_DELTA_PX) {
        devtoolsSeenRef.current = true;
        enqueue("integrity.devtools"); // signal-only (strict-empty payload)
      }
    };

    // ── Fullscreen exits ─────────────────────────────────────────────────────
    let wasFullscreen = document.fullscreenElement !== null;
    const onFullscreenChange = (): void => {
      const now = document.fullscreenElement !== null;
      if (wasFullscreen && !now) enqueue("integrity.fullscreen_exit");
      wasFullscreen = now;
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("keydown", onActivity, { capture: true, passive: true });
    window.addEventListener("mousemove", onActivity, { capture: true, passive: true });
    document.addEventListener("paste", onPaste, true);
    document.addEventListener("copy", onCopy, true);
    document.addEventListener("fullscreenchange", onFullscreenChange);

    const flushTimer = window.setInterval(() => {
      checkDevtools();
      flush();
    }, FLUSH_INTERVAL_MS);

    return () => {
      window.clearInterval(flushTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("keydown", onActivity, { capture: true });
      window.removeEventListener("mousemove", onActivity, { capture: true });
      document.removeEventListener("paste", onPaste, true);
      document.removeEventListener("copy", onCopy, true);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      tabTracker.dispose();
      windowTracker.dispose();
      flush(); // best-effort final drain
    };
  }, [sessionId, enabled]);
}
