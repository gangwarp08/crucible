"use client";
// Verification slice (detector v5) — typing-dynamics window capture.
//
// Behavioral continuity: a mid-session person swap (proxy handoff) shows up
// as a step change in typing rhythm. This hook captures keydown TIMING only —
// never key identity — aggregates it client-side into ~60s windows of rhythm
// statistics, and posts ONLY the aggregated features through the ordinary
// integrity channel (integrity.typing_window). Server-side drift detection
// (services/typing-drift.ts) compares windows to the session-start baseline.
//
// PRIVACY POSTURE (mirrors webcam-presence.ts):
//   - Raw keystrokes never leave the browser. Key IDENTITY is never even
//     recorded here — only a coarse class (char / backspace / nav / mod) and
//     a timestamp, both discarded when the window is reduced to statistics.
//   - Keystroke timing is biometrics-adjacent, so capture is gated behind the
//     SAME explicit v2 consent as the webcam (isProctoringV2Accepted): the
//     hook early-returns before any listener is installed for every
//     unconsented / v1 / declined session.
//   - Every failure is silent; the integrity channel is informational only
//     and never feeds competency scoring.

import { useEffect } from "react";
import { postIntegrityEvents } from "./api";
import { isProctoringV2Accepted } from "./proctoring";

// ── Window & feature parameters ──────────────────────────────────────────────
export const WINDOW_MS = 60_000;   // one feature vector per minute
export const MIN_KEYS = 12;        // windows with fewer keydowns are not posted
export const BURST_IKI_MS = 80;    // inter-key interval below this → burst run
export const PAUSE_IKI_MS = 2_000; // inter-key interval above this → pause
const MAX_IKI_MS = 60_000;         // clamp (schema ceiling; also drops cross-idle gaps)

type KeyClass = "char" | "backspace" | "nav" | "mod";

const NAV_KEYS = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown", "Tab", "Enter", "Escape",
]);
const MOD_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

function classify(key: string): KeyClass {
  if (key === "Backspace" || key === "Delete") return "backspace";
  if (NAV_KEYS.has(key)) return "nav";
  if (MOD_KEYS.has(key)) return "mod";
  return "char"; // which character is deliberately NOT recorded
}

interface WindowFeatures {
  n: number;
  mean_iki_ms: number;
  std_iki_ms: number;
  median_iki_ms: number;
  backspace_ratio: number;
  bursts: number;
  pauses: number;
}

/** Reduce one window's samples ({t, cls}) to its feature vector, or null when
 *  the window is too thin to be statistically meaningful. Exported for the
 *  verify script. */
export function reduceWindow(samples: Array<{ t: number; cls: KeyClass }>): WindowFeatures | null {
  if (samples.length < MIN_KEYS) return null;
  const ikis: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i]!.t - samples[i - 1]!.t;
    if (d >= 0 && d <= MAX_IKI_MS) ikis.push(d);
  }
  if (ikis.length < MIN_KEYS - 1) return null;

  const mean = ikis.reduce((s, v) => s + v, 0) / ikis.length;
  const variance = ikis.reduce((s, v) => s + (v - mean) * (v - mean), 0) / ikis.length;
  const sorted = [...ikis].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;

  let bursts = 0;
  let pauses = 0;
  let inBurst = false;
  for (const d of ikis) {
    if (d < BURST_IKI_MS) {
      if (!inBurst) { bursts++; inBurst = true; }
    } else {
      inBurst = false;
      if (d > PAUSE_IKI_MS) pauses++;
    }
  }
  const backspaces = samples.filter((s) => s.cls === "backspace").length;

  const r2 = (v: number): number => Math.round(v * 100) / 100;
  return {
    n: samples.length,
    mean_iki_ms: r2(Math.min(mean, MAX_IKI_MS)),
    std_iki_ms: r2(Math.min(Math.sqrt(variance), MAX_IKI_MS)),
    median_iki_ms: r2(Math.min(median, MAX_IKI_MS)),
    backspace_ratio: r2(backspaces / samples.length),
    bursts,
    pauses,
  };
}

/**
 * Typing-dynamics capture for a consented proctoring-v2 session.
 *
 * `useTypingDynamics(sessionId, enabled)` — mounted beside useWebcamPresence
 * in the Workspace; capture runs ONLY while `enabled` AND the session's
 * consent marker is set. All listeners/timers tear down on unmount/disable.
 */
export function useTypingDynamics(sessionId: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !sessionId || typeof window === "undefined") return;
    // HARD GATE — same posture as the webcam hook: no recorded v2 consent →
    // no capture of any kind, no listener installed.
    if (!isProctoringV2Accepted(sessionId)) return;

    let samples: Array<{ t: number; cls: KeyClass }> = [];

    const onKeydown = (e: KeyboardEvent): void => {
      // Timing + coarse class only. e.key is read for classification and
      // immediately forgotten — never stored, never posted.
      samples.push({ t: Date.now(), cls: classify(e.key) });
      if (samples.length > 10_000) samples = samples.slice(-5_000); // bound memory
    };

    const flushWindow = (): void => {
      const windowSamples = samples;
      samples = [];
      const features = reduceWindow(windowSamples);
      if (!features) return; // too thin — nothing posted
      void postIntegrityEvents(sessionId, [
        { type: "integrity.typing_window", ts: Date.now(), payload: { ...features } },
      ]);
    };

    window.addEventListener("keydown", onKeydown, { capture: true, passive: true });
    const timer = window.setInterval(flushWindow, WINDOW_MS);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("keydown", onKeydown, { capture: true });
      // Deliberately NOT flushing the partial window on unmount: a sub-minute
      // tail is statistically thin and the session is ending anyway.
      samples = [];
    };
  }, [sessionId, enabled]);
}
