"use client";
import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { AttachAddon } from "@xterm/addon-attach";
import "@xterm/xterm/css/xterm.css";
import { getSessionToken } from "@/lib/api";

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
        background: "#FBF7EF",         // tokens.color.bg.page
        foreground: "#28352F",         // tokens.color.text.primary
        cursor: "#C67C5B",             // tokens.color.accent.base
        cursorAccent: "#FBF7EF",
        selectionBackground: "rgba(198, 124, 91, 0.30)",
        black: "#FBF7EF",
        red: "#BC4B3C",
        green: "#5E9179",
        yellow: "#DDA75C",
        blue: "#C67C5B",
        magenta: "#C67C5B",
        cyan: "#5cc8d7",
        white: "#28352F",
        brightBlack: "#8A9389",
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
    // Pass the per-session JWT as a WS subprotocol — same shape as the
    // messages WS. Server's pty handshake closes with 1008 if the token
    // is missing or doesn't match :sessionId.
    const token = getSessionToken(sessionId);
    const protocols = token ? [`bearer.${token}`] : undefined;
    const ws = new WebSocket(`${wsBase}/pty/${sessionId}`, protocols);
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
