"use client";
import { useEffect, useRef } from "react";
import { gradient } from "@/styles/tokens";

/** Fixed 2px bar across the very top of the viewport that fills with the
 *  fire gradient as the page is scrolled — you burn through the page.
 *  Width is mutated directly (no re-renders) from a passive scroll listener. */
export default function ScrollProgress(): React.ReactElement {
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const el = barRef.current;
      if (!el) return;
      const doc = document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      const p = max > 0 ? Math.min(1, window.scrollY / max) : 0;
      el.style.transform = `scaleX(${p})`;
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      style={{ position: "fixed", top: 0, left: 0, right: 0, height: 2, zIndex: 60, pointerEvents: "none" }}
    >
      <div
        ref={barRef}
        style={{
          height: "100%",
          width: "100%",
          transform: "scaleX(0)",
          transformOrigin: "left",
          background: gradient.fireBar,
        }}
      />
    </div>
  );
}
