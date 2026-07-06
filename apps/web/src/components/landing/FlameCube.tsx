"use client";
import { useEffect, useRef } from "react";

interface Props {
  size?: number;
  intensity?: number;
  hue?: number;
}

interface Flame {
  x: number;
  y: number;
  vy: number;
  vx: number;
  size: number;
  life: number;
  max: number;
  hueOff: number;
  flick: number;
}

interface Spark {
  x: number;
  y: number;
  vy: number;
  vx: number;
  size: number;
  life: number;
  max: number;
  flick: number;
}

/** Slowly-rotating CSS-3D wireframe cube with a canvas fire burning INSIDE
 *  it — the sandboxed testing environment. The flame body is emitted near
 *  the cube floor and dies within the silhouette; only a few bright sparks
 *  escape past the top edge. Used as the hero focal point. */
export default function FlameCube({ size = 200, intensity = 60, hue = 28 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const intRef = useRef(intensity);
  const hueRef = useRef(hue);
  intRef.current = intensity;
  hueRef.current = hue;

  // Canvas is taller than the cube so flames lick up above it.
  const stageW = size * 2.0;
  const stageH = size * 2.6;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced =
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let raf = 0;
    let running = true;
    let visible = true;
    const W = stageW;
    const H = stageH;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const flames: Flame[] = [];
    const sparks: Spark[] = [];
    // Emit near the cube's floor; the cube is centered in the stage, so its
    // bottom face edge sits around H/2 + size/2. The narrow spread + short
    // flame life keep the body inside the wireframe silhouette.
    const baseY = H / 2 + size * 0.32;
    const spread = size * 0.55;
    const cx = W / 2;

    function emit() {
      const n = reduced ? 1 : 3;
      for (let k = 0; k < n; k++) {
        flames.push({
          x: cx + (Math.random() - 0.5) * spread,
          y: baseY + (Math.random() - 0.5) * size * 0.2,
          vy: -(1.1 + Math.random() * 2.0),
          vx: (Math.random() - 0.5) * 0.6,
          size: size * (0.07 + Math.random() * 0.11),
          life: 0,
          max: 26 + Math.random() * 30,
          hueOff: -6 + Math.random() * 24,
          flick: Math.random() * 6.28,
        });
      }
      if (!reduced && Math.random() < 0.55) {
        sparks.push({
          x: cx + (Math.random() - 0.5) * spread * 0.9,
          y: baseY,
          vy: -(2.2 + Math.random() * 2.8),
          vx: (Math.random() - 0.5) * 1.0,
          size: 0.8 + Math.random() * 1.6,
          life: 0,
          max: 60 + Math.random() * 70,
          flick: Math.random() * 6.28,
        });
      }
    }

    function frame() {
      if (!running) return;
      if (!visible) {
        raf = requestAnimationFrame(frame);
        return;
      }
      ctx!.clearRect(0, 0, W, H);
      ctx!.globalCompositeOperation = "lighter";
      const dens = intRef.current / 100;
      const baseHue = hueRef.current;
      const emits = Math.max(1, Math.round((reduced ? 1 : 2) * dens));
      for (let e = 0; e < emits; e++) emit();

      // flame body
      for (let i = flames.length - 1; i >= 0; i--) {
        const p = flames[i]!;
        p.life++;
        const t = p.life / p.max;
        if (t >= 1) {
          flames.splice(i, 1);
          continue;
        }
        p.y += p.vy * (1 - t * 0.35);
        p.x += p.vx + Math.sin(p.life * 0.2 + p.flick) * 0.5;
        const fade = Math.sin(t * Math.PI);
        const a = fade * 0.5;
        const r = p.size * (1.4 - t * 0.7);
        const hueLocal = baseHue + p.hueOff + t * 8;
        const g = ctx!.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        g.addColorStop(0, `hsla(${hueLocal + 18},100%,72%,${a})`);
        g.addColorStop(0.4, `hsla(${hueLocal},100%,52%,${a * 0.55})`);
        g.addColorStop(1, `hsla(${hueLocal - 18},100%,42%,0)`);
        ctx!.fillStyle = g;
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx!.fill();
      }

      // bright sparks
      for (let i = sparks.length - 1; i >= 0; i--) {
        const p = sparks[i]!;
        p.life++;
        const t = p.life / p.max;
        if (t >= 1) {
          sparks.splice(i, 1);
          continue;
        }
        p.vy += 0.012;
        p.y += p.vy;
        p.x += p.vx + Math.sin(p.life * 0.15 + p.flick) * 0.6;
        const fade = Math.sin(t * Math.PI);
        const a = fade * (0.6 + 0.4 * Math.sin(p.life * 0.4 + p.flick));
        const r = p.size * 2.4;
        const hueLocal = baseHue + 18;
        const g = ctx!.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        g.addColorStop(0, `hsla(${hueLocal + 16},100%,82%,${a})`);
        g.addColorStop(0.5, `hsla(${hueLocal},100%,58%,${a * 0.5})`);
        g.addColorStop(1, `hsla(${hueLocal},100%,50%,0)`);
        ctx!.fillStyle = g;
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx!.fill();
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    let io: IntersectionObserver | undefined;
    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver((es) => {
        visible = !!es[0]?.isIntersecting;
      }, { threshold: 0.01 });
      io.observe(wrap);
    }
    const onVis = () => {
      running = !document.hidden;
      if (running) raf = requestAnimationFrame(frame);
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      if (io) io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [size, stageW, stageH]);

  const half = size / 2;
  const faces = ["front", "back", "right", "left", "top", "bottom"] as const;
  const faceTransform: Record<typeof faces[number], string> = {
    front:  `translateZ(${half}px)`,
    back:   `rotateY(180deg) translateZ(${half}px)`,
    right:  `rotateY(90deg) translateZ(${half}px)`,
    left:   `rotateY(-90deg) translateZ(${half}px)`,
    top:    `rotateX(90deg) translateZ(${half}px)`,
    bottom: `rotateX(-90deg) translateZ(${half}px)`,
  };

  return (
    <div
      ref={wrapRef}
      className="cube-stage"
      style={{ width: stageW, height: stageH, position: "relative", display: "grid", placeItems: "center" }}
    >
      <div
        className="cube-glow"
        style={{ width: size * 1.7, height: size * 1.7 }}
      />
      <canvas
        ref={canvasRef}
        className="cube-flame"
        style={{ width: stageW, height: stageH }}
      />
      <div
        className="cube-scene"
        style={{ position: "relative", zIndex: 2, perspective: "900px", width: size, height: size }}
      >
        <div
          className="cube-3d"
          style={{ width: size, height: size, position: "relative", transformStyle: "preserve-3d" }}
        >
          {faces.map((f) => (
            <div
              key={f}
              className="cube-face"
              style={{ width: size, height: size, transform: faceTransform[f], position: "absolute", inset: 0 }}
            />
          ))}
        </div>
        <div className="cube-foot" />
      </div>
    </div>
  );
}
