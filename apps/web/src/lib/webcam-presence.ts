"use client";
// P6.3 (proctoring v2, DORMANT) — in-browser webcam presence heuristic.
//
// PRIVACY POSTURE (the load-bearing part):
//   - Frames NEVER leave the browser. Sampling happens on an offscreen canvas
//     and only DERIVED boolean signals (integrity.face_absent /
//     integrity.multiple_faces) are posted — the same informational integrity
//     channel as v1, isolated from competency scoring server-side.
//   - The hook early-returns BEFORE any getUserMedia call unless BOTH the
//     caller enabled it AND the candidate's recorded consent marker is present
//     (isProctoringV2Accepted). With the org flag off (the dormant default)
//     no consent prompt ever rendered, so the marker cannot exist and no
//     webcam permission prompt can ever appear.
//   - Every failure is silent: denied permission, no camera, play() rejection,
//     canvas errors — the session is never disturbed by proctoring telemetry.
//
// HEURISTIC LIMITS (documented on purpose — this is NOT face recognition):
//   - "Presence" is a cheap luminance statistic on a 64×48 downsample: a
//     covered/black lens or a near-uniform empty scene reads as absent; a
//     poster of a face reads as present. It exists to catch the blatant case
//     (candidate walks away / covers the camera), not to identify anyone.
//   - face_absent needs 2 CONSECUTIVE absent samples (≥ ~40s at the 20s
//     cadence) and re-arms only after a present sample, so brief lighting
//     dips don't fire and a long absence emits once, not continuously.
//   - multiple_faces is a VERY conservative placeholder: it is emitted ONLY
//     where the browser exposes the native FaceDetector API (Chromium behind
//     a flag; absent in Firefox/Safari) AND it reports ≥ 2 faces in 2
//     consecutive samples. No FaceDetector → this signal simply never fires.
//     False positives here are worse than misses — reviewers treat it as a
//     high-confidence flag — so we emit only when we're confident.

import { useEffect } from "react";
import { postIntegrityEvents } from "./api";
import { isProctoringV2Accepted } from "./proctoring";

// ── Cadence & thresholds ─────────────────────────────────────────────────────
const SAMPLE_INTERVAL_MS = 20_000; // one frame every 20s
const SAMPLE_W = 64;               // downsample grid — statistics, not imagery
const SAMPLE_H = 48;
const DARK_MEAN_MAX = 14;          // mean luma below this → lens covered / dark room
const FLAT_STDDEV_MAX = 9;         // luma std-dev below this → near-uniform scene, no foreground
const CONSECUTIVE_FOR_SIGNAL = 2;  // samples in a row before any event is emitted

/** Minimal structural type for the (non-standard) FaceDetector API. */
interface FaceDetectorLike {
  detect(source: CanvasImageSource): Promise<unknown[]>;
}

/** One sample's derived booleans (no pixels retained beyond the call). */
function analyzeFrame(ctx: CanvasRenderingContext2D): { foreground: boolean } {
  const { data } = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
  const n = SAMPLE_W * SAMPLE_H;
  let sum = 0;
  const lumas = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    // Rec. 601 luma — cheap and good enough for a variance statistic.
    const l = 0.299 * data[o]! + 0.587 * data[o + 1]! + 0.114 * data[o + 2]!;
    lumas[i] = l;
    sum += l;
  }
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const d = lumas[i]! - mean;
    varSum += d * d;
  }
  const stddev = Math.sqrt(varSum / n);
  // "Significant foreground": the scene is neither blacked out nor flat.
  return { foreground: mean > DARK_MEAN_MAX && stddev > FLAT_STDDEV_MAX };
}

/**
 * Periodic webcam presence sampling for a consented proctoring-v2 session.
 *
 * `useWebcamPresence(sessionId, enabled)` — capture runs ONLY while `enabled`
 * AND the session's consent marker is set; everything tears down (tracks
 * stopped, timers cleared) on unmount or disable. Signals go through the same
 * fire-and-forget postIntegrityEvents path as v1 (signal-only events, no
 * payload — matching the shared IntegrityEventSchema's strict-empty shape).
 */
export function useWebcamPresence(sessionId: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !sessionId || typeof window === "undefined") return;
    // HARD GATE — before any capture API is touched. No recorded consent
    // (which includes every flag-off / link-less / declined session) means
    // this effect is a no-op and no permission prompt can appear.
    if (!isProctoringV2Accepted(sessionId)) return;
    if (!navigator.mediaDevices?.getUserMedia) return;

    let disposed = false;
    let stream: MediaStream | null = null;
    let video: HTMLVideoElement | null = null;
    let timer: number | null = null;

    // Conservative optional face counter (see header for limits).
    const FaceDetectorCtor = (window as unknown as {
      FaceDetector?: new (opts?: { maxDetectedFaces?: number }) => FaceDetectorLike;
    }).FaceDetector;
    let faceDetector: FaceDetectorLike | null = null;
    try {
      if (FaceDetectorCtor) faceDetector = new FaceDetectorCtor({ maxDetectedFaces: 3 });
    } catch { faceDetector = null; }

    let absentStreak = 0;
    let absentEmitted = false;
    let multiStreak = 0;
    let multiEmitted = false;

    const emit = (type: string): void => {
      // Signal-only (no payload) — derived boolean, nothing else, ever.
      void postIntegrityEvents(sessionId, [{ type, ts: Date.now() }]);
    };

    const sample = async (): Promise<void> => {
      if (disposed || !video || video.readyState < 2) return;
      try {
        const canvas = document.createElement("canvas"); // offscreen; GC'd per sample
        canvas.width = SAMPLE_W;
        canvas.height = SAMPLE_H;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
        const { foreground } = analyzeFrame(ctx);

        if (foreground) {
          absentStreak = 0;
          absentEmitted = false; // re-arm: a later absence is a new signal
        } else {
          absentStreak++;
          if (absentStreak >= CONSECUTIVE_FOR_SIGNAL && !absentEmitted) {
            absentEmitted = true;
            emit("integrity.face_absent");
          }
        }

        if (faceDetector && foreground) {
          // Detect on the full-res video frame, not the 64×48 thumbnail.
          const faces = await faceDetector.detect(video).catch(() => [] as unknown[]);
          if (disposed) return;
          if (faces.length >= 2) {
            multiStreak++;
            if (multiStreak >= CONSECUTIVE_FOR_SIGNAL && !multiEmitted) {
              multiEmitted = true;
              emit("integrity.multiple_faces");
            }
          } else {
            multiStreak = 0;
            multiEmitted = false;
          }
        }
      } catch { /* silent — proctoring must never break the session */ }
    };

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
          audio: false,
        });
      } catch {
        return; // permission denied / no camera → silently stay v1-passive
      }
      if (disposed) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
        return;
      }
      try {
        video = document.createElement("video"); // offscreen — never in the DOM
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await video.play();
      } catch {
        stream?.getTracks().forEach((t) => t.stop());
        stream = null;
        video = null;
        return;
      }
      if (disposed) return; // cleanup below already ran? tracks handled there
      timer = window.setInterval(() => { void sample(); }, SAMPLE_INTERVAL_MS);
    })();

    return () => {
      disposed = true;
      if (timer !== null) window.clearInterval(timer);
      if (video) {
        video.pause();
        video.srcObject = null;
        video = null;
      }
      // Stop tracks LAST so the camera indicator light turns off immediately
      // on unmount / session end.
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    };
  }, [sessionId, enabled]);
}
