"use client";
import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { ReviewEvent } from "@/lib/api";
import { color, radius, font } from "@/styles/tokens";

interface Props {
  events: ReviewEvent[];
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export default function TerminalReplay({ events }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  const outputEvents = events
    .filter((e) => e.type === "pty.output")
    .sort((a, b) => a.seq - b.seq);
  const totalBytes = outputEvents.reduce((sum, e) => {
    const b = e.payload["bytes"];
    return sum + (typeof b === "number" ? b : 0);
  }, 0);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      // Theme built from the asaya brand tokens. ANSI red/green/yellow map to
      // the semantic error/success/warn tokens; blue/cyan/magenta stay as
      // readable cool colors — terminal semantics, not brand accents.
      theme: {
        background: color.bg.input,
        foreground: color.text.primary,
        cursor: color.accent.base,
        cursorAccent: color.bg.input,
        selectionBackground: color.accent.glow,
        red: color.error.base,
        green: color.success.base,
        yellow: color.warn.base,
        brightRed: color.error.base,
        brightGreen: color.success.base,
        brightYellow: color.warn.base,
      },
      fontSize: 12,
      fontFamily: font.mono,
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: "bar",
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    // Write all output in seq order — single batched write to xterm.
    for (const e of outputEvents) {
      const data = e.payload["data"];
      if (typeof data !== "string") continue;
      try {
        term.write(base64ToBytes(data));
      } catch {
        // skip malformed base64
      }
    }

    const observer = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch { /* terminal disposed */ }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      term.dispose();
    };
  }, [events, outputEvents]);

  return (
    <section
      style={{
        background: color.bg.panel,
        border: `1px solid ${color.border.default}`,
        borderRadius: radius.md,
        marginBottom: 16,
        overflow: "hidden",
      }}
    >
      <header
        style={{
          padding: "10px 16px",
          background: color.bg.elevated,
          borderBottom: `1px solid ${color.border.default}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: color.text.secondary, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Terminal (final state)
        </span>
        <span style={{ fontSize: 11, color: color.text.muted, fontFamily: font.mono }}>
          {outputEvents.length} output frames · {totalBytes.toLocaleString()} bytes
        </span>
      </header>

      <div style={{ padding: "8px 8px 4px", background: color.bg.input }}>
        {outputEvents.length === 0 ? (
          <div style={{ padding: 24, color: color.text.muted, fontSize: 13, textAlign: "center" }}>
            No terminal output recorded
          </div>
        ) : (
          <div ref={containerRef} style={{ width: "100%", height: 360 }} />
        )}
      </div>
    </section>
  );
}
