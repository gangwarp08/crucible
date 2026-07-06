"use client";
import { useEffect, useRef, useState } from "react";

interface Props {
  children: React.ReactNode;
  /** Extra transition delay in ms, for staggering siblings. */
  delay?: number;
  style?: React.CSSProperties;
}

/** Scroll-reveal wrapper: fades + slides content up the first time it enters
 *  the viewport. Pure CSS transition driven by an IntersectionObserver;
 *  prefers-reduced-motion is handled in globals.css (.reveal rules). */
export default function Reveal({ children, delay = 0, style }: Props): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // No IntersectionObserver (very old browser, some headless renderers):
    // show everything rather than hiding content forever.
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={visible ? "reveal reveal-in" : "reveal"}
      style={{ transitionDelay: delay ? `${delay}ms` : undefined, ...style }}
    >
      {children}
    </div>
  );
}
