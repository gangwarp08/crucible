"use client";
// Verification continuity (dormant) — in-browser face-embedding seam.
//
// THE SEAM: computeFaceEmbedding(source) → L2-normalized vector + the
// embedder's model version. Everything downstream (enrolment anchor storage,
// the continuity POST, server-side cosine compare, thresholds) is
// embedder-agnostic; the server version-gates compares on EMBED_MODEL_VERSION
// so vectors never compare across embedder upgrades.
//
// CURRENT IMPLEMENTATION — PLACEHOLDER QUALITY, BY DESIGN:
//   A deterministic luminance-grid vector (16×8 grayscale downsample,
//   L2-normalized). It exercises the full continuity path end-to-end and
//   catches the blatant cases (camera covered, completely different scene),
//   but it is NOT face recognition — lighting and pose shifts move it.
//
// UPGRADE PATH (pinned here so it is a fill-in, not a design exercise):
//   Swap `embedFromCanvas` for a real face-recognition embedder running in
//   the browser via onnxruntime-web with a self-hosted model under
//   apps/web/public/models/ (no CDN — CSP forbids external hosts):
//     1. Vet the model LICENSE for commercial use first — the strong open
//        checkpoints (InsightFace MobileFaceNet/ArcFace family) ship
//        research-only weights; a commercial-grade pick needs diligence.
//     2. Detect + crop the face (native FaceDetector where available, else
//        the model's detector), embed the crop, L2-normalize.
//     3. Bump EMBED_MODEL_VERSION (e.g. "mobilefacenet-v1"). Old anchors stay
//        valid for their own sessions; new sessions enrol on the new version.
//   Nothing else changes: same POST shapes, same anchor table, same events.
//
// PRIVACY POSTURE: frames never leave this module — the source canvas is
// read, reduced to the vector, and dropped. Only the vector is returned.

export const EMBED_MODEL_VERSION = "luma-grid-v0";
export const EMBED_DIM = 128; // 16 × 8 grid

const GRID_W = 16;
const GRID_H = 8;

/** Compute the embedding from any drawable source (the webcam <video> element
 *  or a captured selfie image). Returns null on any failure — continuity is
 *  informational and silently degrades, like every proctoring path. */
export function computeFaceEmbedding(source: CanvasImageSource): number[] | null {
  try {
    const canvas = document.createElement("canvas"); // offscreen; GC'd per call
    canvas.width = GRID_W;
    canvas.height = GRID_H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, GRID_W, GRID_H);
    const { data } = ctx.getImageData(0, 0, GRID_W, GRID_H);

    const v = new Array<number>(EMBED_DIM);
    for (let i = 0; i < EMBED_DIM; i++) {
      const o = i * 4;
      // Rec. 601 luma, mean-free later via normalization.
      v[i] = 0.299 * data[o]! + 0.587 * data[o + 1]! + 0.114 * data[o + 2]!;
    }
    // Mean-center then L2-normalize → cosine similarity is lighting-DC-invariant.
    const mean = v.reduce((s, x) => s + x, 0) / EMBED_DIM;
    let norm = 0;
    for (let i = 0; i < EMBED_DIM; i++) {
      v[i] = v[i]! - mean;
      norm += v[i]! * v[i]!;
    }
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || norm < 1e-6) return null; // flat frame — no signal
    for (let i = 0; i < EMBED_DIM; i++) v[i] = Math.round((v[i]! / norm) * 1e6) / 1e6;
    return v;
  } catch {
    return null;
  }
}

// ── Enrolment marker ─────────────────────────────────────────────────────────
// Set after the server confirmed it stored the anchor; read by the continuity
// sampler so sessions without an anchor never post. Same sessionStorage
// posture as the consent marker (lib/proctoring.ts).

const ANCHOR_KEY_PREFIX = "crucible.anchor.";

export function markAnchorEnrolled(sessionId: string): void {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.setItem(`${ANCHOR_KEY_PREFIX}${sessionId}`, "1"); } catch { /* ignore */ }
}

export function isAnchorEnrolled(sessionId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(`${ANCHOR_KEY_PREFIX}${sessionId}`) === "1";
  } catch {
    return false;
  }
}
