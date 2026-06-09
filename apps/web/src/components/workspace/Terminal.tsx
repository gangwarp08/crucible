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

    // Track whether the WS actually established. Without this guard,
    // (a) a transient connection failure during component-mount (sandbox
    //     not ready, 404, network blip) closes with code 1006, and
    // (b) a normal Workspace unmount calling ws.close() with no code
    //     closes with the default (non-1000) code
    // — both falsely look like "server-initiated session end" and flip
    // the global store status to "ended", which renders EndScreen over
    // the NEXT session that mounts. Only treat the close as a real
    // session-end when (1) the WS opened successfully first, AND (2)
    // we didn't initiate the close ourselves via the cleanup below.
    let opened = false;
    let selfClosed = false;
    ws.addEventListener("open", () => { opened = true; });
    ws.addEventListener("close", (ev) => {
      if (!opened || selfClosed) return;
      if (ev.code !== 1000) {
        onSessionEnd?.();
      }
    });

    const observer = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch { /* terminal may be disposed */ }
    });
    observer.observe(containerRef.current);

    return () => {
      selfClosed = true;
      observer.disconnect();
      ws.close(1000, "client unmount");
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
