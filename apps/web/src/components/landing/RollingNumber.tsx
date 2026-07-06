"use client";
import { useEffect, useRef, useState } from "react";

interface Props {
  /** Final integer value to roll to. */
  end: number;
  prefix?: string;
  suffix?: string;
}

/** Odometer-style rolling digits: every digit is a vertical strip of 0-9
 *  that spins to its target when the number scrolls into view, and rolls
 *  back when it leaves — so the stats re-roll on every pass. Digits land
 *  right-to-left via a small stagger. Static under reduced motion. */
export default function RollingNumber({ end, prefix = "", suffix = "" }: Props): React.ReactElement {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [active, setActive] = useState(false);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setActive(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => setActive(entries.some((e) => e.isIntersecting)),
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const chars = String(end).split("");
  const shown = reduced || active;

  return (
    <span
      ref={ref}
      style={{ display: "inline-flex", alignItems: "baseline", whiteSpace: "nowrap" }}
      aria-label={`${prefix}${end.toLocaleString("en-US")}${suffix}`}
    >
      {prefix}
      {chars.map((ch, i) =>
        /\d/.test(ch) ? (
          <span
            key={i}
            aria-hidden="true"
            style={{
              display: "inline-block",
              height: "1em",
              lineHeight: 1,
              overflow: "hidden",
            }}
          >
            <span
              style={{
                display: "block",
                transform: `translateY(${shown ? -Number(ch) : 0}em)`,
                transition: reduced
                  ? "none"
                  : `transform 950ms cubic-bezier(0.2, 0.75, 0.2, 1) ${(chars.length - 1 - i) * 90}ms`,
              }}
            >
              {Array.from({ length: 10 }, (_, d) => (
                <span key={d} style={{ display: "block", height: "1em", lineHeight: 1 }}>
                  {d}
                </span>
              ))}
            </span>
          </span>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
      {suffix}
    </span>
  );
}
