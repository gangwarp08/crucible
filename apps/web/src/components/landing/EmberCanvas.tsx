"use client";
import { useEffect, useRef } from "react";

interface Props {
  /** 0-100. Higher = more particles. */
  intensity?: number;
  /** Base hue in degrees. 28 ≈ design's orange. */
  hue?: number;
}

interface Particle {
  x: number;
  y: number;
  vy: number;
  vx: number;
  size: number;
  life: number;
  max: number;
  flick: number;
  hueOff: number;
}

/** Full-viewport, fixed-position canvas of slowly-rising fire embers. Calm
 *  ambient layer for the landing page. Auto-pauses when the tab is hidden
 *  and respects prefers-reduced-motion (drops cap from 60 → 14 particles). */
export default function EmberCanvas({ intensity = 50, hue = 34 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const intRef = useRef(intensity);
  const hueRef = useRef(hue);
  intRef.current = intensity;
  hueRef.current = hue;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0;
    let h = 0;
    let raf = 0;
    let running = true;
    const parts: Particle[] = [];

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);

    function spawn() {
      parts.push({
        x: Math.random() * w,
        y: h + Math.random() * 30,
        vy: -(0.18 + Math.random() * 0.55),
        vx: (Math.random() - 0.5) * 0.18,
        size: 0.8 + Math.random() * 2.0,
        life: 0,
        max: 260 + Math.random() * 360,
        flick: Math.random() * Math.PI * 2,
        hueOff: -8 + Math.random() * 22,
      });
    }

    function frame() {
      if (!running) return;
      ctx!.clearRect(0, 0, w, h);
      ctx!.globalCompositeOperation = "lighter";
      const baseHue = hueRef.current;
      const target = Math.round((intRef.current / 100) * (reduced ? 14 : 60));
      if (parts.length < target && Math.random() < 0.5) spawn();

      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]!;
        p.life++;
        p.y += p.vy;
        p.x += p.vx + Math.sin(p.life * 0.03 + p.flick) * 0.25;
        const t = p.life / p.max;
        if (t >= 1 || p.y < -20) {
          parts.splice(i, 1);
          continue;
        }
        const fade = Math.sin(t * Math.PI);
        const a = fade * (0.55 + 0.45 * Math.sin(p.life * 0.25 + p.flick)) * 0.9;
        const hueLocal = baseHue + p.hueOff;
        const r = p.size * 4;
        const g = ctx!.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        g.addColorStop(0, `hsla(${hueLocal + 12},66%,72%,${a})`);
        g.addColorStop(0.35, `hsla(${hueLocal},66%,55%,${a * 0.5})`);
        g.addColorStop(1, `hsla(${hueLocal - 14},66%,46%,0)`);
        ctx!.fillStyle = g;
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx!.fill();
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    const onVis = () => {
      running = !document.hidden;
      if (running) raf = requestAnimationFrame(frame);
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100%",
        zIndex: 0,
        pointerEvents: "none",
        display: "block",
      }}
    />
  );
}
