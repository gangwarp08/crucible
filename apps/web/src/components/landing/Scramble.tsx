"use client";
import { useEffect, useRef, useState } from "react";

const GLYPHS = "▪·<>/#_01";

interface Props {
  text: string;
  /** Total decode time in ms. */
  duration?: number;
}

/** Terminal-style decode-in: the string starts as telemetry noise and
 *  resolves left-to-right into the real text the first time it scrolls
 *  into view. Static under prefers-reduced-motion. */
export default function Scramble({ text, duration = 700 }: Props): React.ReactElement {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [display, setDisplay] = useState(text);
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (
      typeof IntersectionObserver === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return; // leave the plain text in place
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting) || started.current) return;
        started.current = true;
        io.disconnect();
        const t0 = performance.now();
        let raf = 0;
        const tick = (t: number) => {
          const p = Math.min(1, (t - t0) / duration);
          const solved = Math.floor(p * text.length);
          let out = text.slice(0, solved);
          for (let i = solved; i < text.length; i++) {
            const c = text[i]!;
            out += c === " " ? " " : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
          }
          setDisplay(out);
          if (p < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [text, duration]);

  return <span ref={ref}>{display}</span>;
}
