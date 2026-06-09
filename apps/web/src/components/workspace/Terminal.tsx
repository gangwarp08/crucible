"use client";
import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { AttachAddon } from "@xterm/addon-attach";
import "@xterm/xterm/css/xterm.css";

interface Props {
  sessionId: string;
  onSessionEnd?: () => void;
}

const SERVER_URL = process.env["NEXT_PUBLIC_SERVER_URL"] ?? "http://localhost:3001";

export default function Terminal({ sessionId, onSessionEnd }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      theme: {
        background: "#0c0c10",         // tokens.color.bg.page
        foreground: "#e6e6ea",         // tokens.color.text.primary
        cursor: "#7c7fff",             // tokens.color.accent.base
        cursorAccent: "#0c0c10",
        selectionBackground: "rgba(124, 127, 255, 0.30)",
        black: "#0c0c10",
        red: "#ff7a7a",
        green: "#56d6a8",
        yellow: "#e0b66e",
        blue: "#7c7fff",
        magenta: "#b48ce6",
        cyan: "#5cc8d7",
        white: "#e6e6ea",
        brightBlack: "#6a6a78",
      },
      fontSize: 13,
      fontFamily: "var(--font-mono, 'JetBrains Mono', SFMono-Regular, Menlo, Consolas, monospace)",
      cursorBlink: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    const wsBase = SERVER_URL.replace(/^http/, "ws");
    const ws = new WebSocket(`${wsBase}/pty/${sessionId}`);
    ws.binaryType = "arraybuffer";

    const attachAddon = new AttachAddon(ws);
    term.loadAddon(attachAddon);

    // When the server closes the PTY socket (session expired), notify the workspace.
    ws.addEventListener("close", (ev) => {
      // code 1000 = normal close (user navigated away); anything else = server-initiated.
      if (ev.code !== 1000) {
        onSessionEnd?.();
      }
    });

    const observer = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch { /* terminal may be disposed */ }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      ws.close();
      term.dispose();
    };
  }, [sessionId, onSessionEnd]);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", padding: "4px 8px" }}
    />
  );
}
