"use client";
import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { ReviewEvent } from "@/lib/api";

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
      theme: {
        background: "#1e1e1e",
        foreground: "#cccccc",
        cursor: "#1e1e1e", // hide cursor (read-only)
        selectionBackground: "#264f78",
      },
      fontSize: 12,
      fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
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
        background: "#252526",
        border: "1px solid #404040",
        borderRadius: 6,
        marginBottom: 16,
        overflow: "hidden",
      }}
    >
      <header
        style={{
          padding: "10px 16px",
          background: "#2d2d2d",
          borderBottom: "1px solid #404040",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: "#858585", letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Terminal (final state)
        </span>
        <span style={{ fontSize: 11, color: "#666", fontFamily: "monospace" }}>
          {outputEvents.length} output frames · {totalBytes.toLocaleString()} bytes
        </span>
      </header>

      <div style={{ padding: "8px 8px 4px", background: "#1e1e1e" }}>
        {outputEvents.length === 0 ? (
          <div style={{ padding: 24, color: "#666", fontSize: 13, textAlign: "center" }}>
            No terminal output recorded
          </div>
        ) : (
          <div ref={containerRef} style={{ width: "100%", height: 360 }} />
        )}
      </div>
    </section>
  );
}
