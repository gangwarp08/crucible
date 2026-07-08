"use client";
// P6.2 web side (proctoring v2, DORMANT) — pre-workspace identity capture.
//
// Rendered ONLY after the candidate explicitly ACCEPTED the v2 consent prompt
// (StartScreen gates it; the dormant default never reaches this component).
// The candidate captures a government-ID photo and a selfie — from the live
// camera or a file — and explicitly submits BOTH. Those two images are the
// only frames that ever leave the browser; the server compares them through
// the LiteLLM gateway, stores only the derived result, and discards the raws.
//
// NEVER BLOCKS: verification is informational. Camera denied, upload broken,
// server missing the endpoint, low match — every path ends at the same
// "Enter workspace" continuation, at most with a one-line note.

import { useEffect, useRef, useState } from "react";
import { postIdentityVerify } from "@/lib/proctoring";
import { color, radius } from "@/styles/tokens";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import SectionLabel from "@/components/ui/SectionLabel";

interface Props {
  sessionId: string;
  /** Always reachable — identity capture may inform, never gate. */
  onContinue: () => void;
}

// Client-side downscale keeps each JPEG comfortably under Fastify's default
// 1 MiB JSON body limit (two images per POST): longest edge 800px, q=0.75.
const MAX_EDGE = 800;
const JPEG_QUALITY = 0.75;

type Slot = "id" | "selfie";

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "done"; verified: boolean }
  | { kind: "failed" };

function scaleToDataUrl(source: CanvasImageSource, w: number, h: number): string | null {
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  try {
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } catch {
    return null;
  }
}

export default function IdentityCapture({ sessionId, onContinue }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [images, setImages] = useState<{ id: string | null; selfie: string | null }>({
    id: null,
    selfie: null,
  });
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });

  // Live preview for in-browser capture. Denied/no camera is NOT an error —
  // the file inputs below remain, and Continue is always available.
  useEffect(() => {
    let disposed = false;
    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
          audio: false,
        });
        if (disposed) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => { /* preview only */ });
        }
        setCameraOn(true);
      } catch { /* camera unavailable — file inputs still work */ }
    })();
    return () => {
      disposed = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  function captureFromCamera(slot: Slot): void {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;
    const dataUrl = scaleToDataUrl(video, video.videoWidth, video.videoHeight);
    if (dataUrl) setImages((prev) => ({ ...prev, [slot]: dataUrl }));
  }

  function loadFromFile(slot: Slot, file: File | null): void {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const dataUrl = scaleToDataUrl(img, img.naturalWidth, img.naturalHeight);
      URL.revokeObjectURL(url);
      if (dataUrl) setImages((prev) => ({ ...prev, [slot]: dataUrl }));
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  async function submitImages(): Promise<void> {
    if (!images.id || !images.selfie) return;
    setSubmit({ kind: "submitting" });
    const result = await postIdentityVerify(sessionId, {
      idImage: images.id,
      selfieImage: images.selfie,
    });
    // Stop the camera the moment the explicit submission is done — nothing
    // else here needs it (webcam presence, if consented, re-acquires inside
    // the workspace with its own lifecycle).
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
    if (result === null) setSubmit({ kind: "failed" });
    else setSubmit({ kind: "done", verified: result.verified });
  }

  const ready = images.id !== null && images.selfie !== null;
  const finished = submit.kind === "done" || submit.kind === "failed";

  return (
    <Card padding={6}>
      <SectionLabel tone="eyebrow">Identity verification</SectionLabel>
      <div style={{ fontSize: 22, color: color.text.primary, fontWeight: 600, marginTop: 14, marginBottom: 8 }}>
        Verify it&apos;s you
      </div>
      <p style={{ color: color.text.secondary, fontSize: 13, lineHeight: 1.6, margin: "0 0 18px" }}>
        Capture a photo of a government ID and a selfie. Both images are used
        once to check the match, then discarded — only the result is kept.
        This is informational for the reviewer and never blocks your session.
      </p>

      {cameraOn && !finished && (
        <video
          ref={videoRef}
          muted
          playsInline
          style={{
            width: 320,
            borderRadius: radius.md,
            border: `1px solid ${color.border.default}`,
            marginBottom: 16,
            display: "block",
            transform: "scaleX(-1)", // mirror preview; captures stay unmirrored
          }}
        />
      )}
      {/* Hidden working video when camera is on but preview finished */}
      {!cameraOn && !finished && (
        <video ref={videoRef} muted playsInline style={{ display: "none" }} />
      )}

      {!finished && (
        <div style={{ display: "flex", gap: 24, marginBottom: 20, flexWrap: "wrap" }}>
          <CaptureSlot
            label="Government ID"
            image={images.id}
            cameraOn={cameraOn}
            onCapture={() => captureFromCamera("id")}
            onFile={(f) => loadFromFile("id", f)}
          />
          <CaptureSlot
            label="Selfie"
            image={images.selfie}
            cameraOn={cameraOn}
            onCapture={() => captureFromCamera("selfie")}
            onFile={(f) => loadFromFile("selfie", f)}
          />
        </div>
      )}

      {submit.kind === "done" && (
        <p style={{ color: submit.verified ? color.success.base : color.warn.base, fontSize: 13, margin: "0 0 16px", lineHeight: 1.6 }}>
          {submit.verified
            ? "Identity check submitted — match confirmed."
            : "Identity check submitted. The images didn't confidently match — a reviewer will see this as context only; your session is unaffected."}
        </p>
      )}
      {submit.kind === "failed" && (
        <p style={{ color: color.text.muted, fontSize: 13, margin: "0 0 16px", lineHeight: 1.6 }}>
          Identity verification couldn&apos;t be completed — continuing without
          it. This never affects your assessment.
        </p>
      )}

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        {!finished && (
          <Button
            variant="primary"
            size="md"
            disabled={!ready || submit.kind === "submitting"}
            onClick={() => void submitImages()}
          >
            {submit.kind === "submitting" ? "Verifying…" : "Submit for verification"}
          </Button>
        )}
        {finished ? (
          <Button variant="primary" size="md" onClick={onContinue}>
            Enter workspace
          </Button>
        ) : (
          <Button variant="ghost" size="md" disabled={submit.kind === "submitting"} onClick={onContinue}>
            Continue without verifying
          </Button>
        )}
      </div>
    </Card>
  );
}

function CaptureSlot({
  label, image, cameraOn, onCapture, onFile,
}: {
  label: string;
  image: string | null;
  cameraOn: boolean;
  onCapture: () => void;
  onFile: (file: File | null) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ fontSize: 12, color: color.text.muted }}>{label}</span>
      <div
        style={{
          width: 200,
          height: 130,
          borderRadius: radius.md,
          border: `1px dashed ${image ? color.success.base : color.border.default}`,
          background: color.bg.elevated,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {image ? (
          // Plain <img>: this is a local data-URL preview (never a remote
          // asset), so next/image optimization doesn't apply.
          <img src={image} alt={`${label} preview`} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <span style={{ fontSize: 11, color: color.text.muted }}>No image yet</span>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {cameraOn && (
          <Button variant="ghost" size="sm" onClick={onCapture}>
            {image ? "Retake" : "Capture"}
          </Button>
        )}
        <label style={{ fontSize: 11, color: color.text.secondary, cursor: "pointer", textDecoration: "underline" }}>
          upload
          <input
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => onFile(e.target.files?.[0] ?? null)}
          />
        </label>
      </div>
    </div>
  );
}
