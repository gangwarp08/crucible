"use client";
import { useEffect, useRef, useState } from "react";

interface Props {
  sessionId: string;
}

type Channel = "client" | "team";

interface PersonaMessage {
  role: "candidate" | "persona";
  text: string;
  personaName?: string;
  ts: string;
}

type Inbound =
  | {
      type?: undefined;
      channel: Channel;
      role: "persona";
      persona_name: string;
      text: string;
      ts: string;
    }
  | { type: "error"; code: string; message: string };

const CHANNEL_META: Record<Channel, { label: string; sublabel: string }> = {
  client: { label: "Client", sublabel: "Dana, VP Finance" },
  team:   { label: "Team",   sublabel: "Sam, senior engineer" },
};

const SERVER_URL =
  process.env["NEXT_PUBLIC_SERVER_URL"] ?? "http://localhost:3001";

export default function Messages({ sessionId }: Props) {
  const [active, setActive] = useState<Channel>("client");
  const [threads, setThreads] = useState<Record<Channel, PersonaMessage[]>>({
    client: [],
    team: [],
  });
  const [awaiting, setAwaiting] = useState<Record<Channel, boolean>>({
    client: false,
    team: false,
  });
  const [drafts, setDrafts] = useState<Record<Channel, string>>({
    client: "",
    team: "",
  });
  const [unread, setUnread] = useState<Record<Channel, number>>({
    client: 0,
    team: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  // Refs so the WS message handler (registered once per sessionId) can read
  // the latest active channel without re-subscribing on every tab switch.
  const activeRef = useRef<Channel>(active);
  useEffect(() => { activeRef.current = active; }, [active]);

  const wsRef = useRef<WebSocket | null>(null);
  const clientBottom = useRef<HTMLDivElement>(null);
  const teamBottom = useRef<HTMLDivElement>(null);

  // Auto-scroll the active thread when a new message lands.
  useEffect(() => {
    const r = active === "client" ? clientBottom : teamBottom;
    r.current?.scrollIntoView({ behavior: "smooth" });
  }, [active, threads]);

  useEffect(() => {
    const wsBase = SERVER_URL.replace(/^http/, "ws");
    const ws = new WebSocket(`${wsBase}/messages/${sessionId}`);
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      setConnected(true);
      setError(null);
    });

    ws.addEventListener("message", (ev) => {
      let parsed: Inbound;
      try {
        parsed = JSON.parse(typeof ev.data === "string" ? ev.data : "") as Inbound;
      } catch {
        return;
      }
      if (parsed.type === "error") {
        setError(parsed.message);
        // Best-effort: clear awaiting on both since we don't know which one this was tied to.
        setAwaiting({ client: false, team: false });
        return;
      }
      setThreads((prev) => ({
        ...prev,
        [parsed.channel]: [
          ...prev[parsed.channel],
          {
            role: "persona",
            text: parsed.text,
            personaName: parsed.persona_name,
            ts: parsed.ts,
          },
        ],
      }));
      setAwaiting((prev) => ({ ...prev, [parsed.channel]: false }));
      // Unread badge: bump the counter only when the message lands on a
      // channel the user is not currently viewing. Reset happens in setActive.
      if (parsed.channel !== activeRef.current) {
        setUnread((prev) => ({
          ...prev,
          [parsed.channel]: prev[parsed.channel] + 1,
        }));
      }
    });

    ws.addEventListener("close", () => {
      setConnected(false);
    });

    ws.addEventListener("error", () => {
      setError("Messaging connection error.");
      setConnected(false);
    });

    return () => {
      try { ws.close(); } catch { /* already closing */ }
    };
  }, [sessionId]);

  function send(channel: Channel) {
    const draft = drafts[channel].trim();
    if (!draft || awaiting[channel] || !wsRef.current || wsRef.current.readyState !== 1) return;

    const optimistic: PersonaMessage = {
      role: "candidate",
      text: draft,
      ts: new Date().toISOString(),
    };
    setThreads((prev) => ({
      ...prev,
      [channel]: [...prev[channel], optimistic],
    }));
    setDrafts((prev) => ({ ...prev, [channel]: "" }));
    setAwaiting((prev) => ({ ...prev, [channel]: true }));
    setError(null);

    wsRef.current.send(JSON.stringify({ channel, text: draft }));
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#1e1e1e",
        overflow: "hidden",
      }}
    >
      {/* Sub-tab strip (Client | Team) — mirrors the right-column tab strip in Workspace.tsx */}
      <div
        style={{
          display: "flex",
          background: "#2d2d2d",
          borderBottom: "1px solid #404040",
          flexShrink: 0,
          userSelect: "none",
        }}
      >
        {(["client", "team"] as const).map((c) => {
          const isActive = active === c;
          const isAwaiting = awaiting[c];
          const unreadCount = unread[c];
          return (
            <button
              key={c}
              onClick={() => {
                setActive(c);
                // Clear the unread badge when the user opens this tab.
                if (unread[c] > 0) {
                  setUnread((prev) => ({ ...prev, [c]: 0 }));
                }
              }}
              style={{
                padding: "6px 14px",
                background: "transparent",
                border: "none",
                borderBottom: isActive ? "2px solid #3794ff" : "2px solid transparent",
                color: isActive ? "#cccccc" : "#858585",
                fontSize: 12,
                fontFamily: "inherit",
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {CHANNEL_META[c].label}
              {/* Unread badge only renders on the inactive tab. On the active
                  tab the typing-dots indicator takes priority. */}
              {!isActive && unreadCount > 0 && (
                <span
                  style={{
                    background: "#3794ff",
                    color: "#fff",
                    fontSize: 10,
                    fontWeight: 600,
                    padding: "1px 6px",
                    borderRadius: 9,
                    minWidth: 16,
                    textAlign: "center",
                    lineHeight: "14px",
                  }}
                >
                  {unreadCount}
                </span>
              )}
              {isActive && isAwaiting && (
                <span style={{ color: "#3794ff", fontSize: 10 }}>···</span>
              )}
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        {!connected && (
          <div
            style={{
              padding: "6px 12px",
              color: "#dcb67a",
              fontSize: 11,
              alignSelf: "center",
            }}
          >
            disconnected
          </div>
        )}
      </div>

      {/* Both threads stay mounted; toggle visible one via display:none. */}
      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
        {(["client", "team"] as const).map((c) => (
          <div
            key={c}
            style={{
              position: "absolute",
              inset: 0,
              display: active === c ? "flex" : "none",
              flexDirection: "column",
            }}
          >
            {/* Per-channel header */}
            <div
              style={{
                padding: "5px 12px",
                background: "#252526",
                borderBottom: "1px solid #404040",
                fontSize: 12,
                color: "#858585",
                userSelect: "none",
                letterSpacing: "0.02em",
                flexShrink: 0,
              }}
            >
              {CHANNEL_META[c].sublabel}
            </div>

            {/* Error banner (shared, but rendered inside each pane) */}
            {error && (
              <div
                style={{
                  padding: "8px 12px",
                  background: "#4b2020",
                  color: "#f48771",
                  fontSize: 12,
                  flexShrink: 0,
                }}
              >
                {error}
              </div>
            )}

            {/* Message list */}
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "8px 0",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              {threads[c].length === 0 && (
                <div
                  style={{
                    color: "#555",
                    fontSize: 12,
                    textAlign: "center",
                    padding: "24px 12px",
                    lineHeight: 1.5,
                  }}
                >
                  {c === "client"
                    ? "Start a conversation with the client (Dana)."
                    : "Ping your teammate (Sam)."}
                </div>
              )}
              {threads[c].map((m, i) => (
                <div
                  key={i}
                  style={{
                    padding: "6px 12px",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: m.role === "candidate" ? "flex-end" : "flex-start",
                  }}
                >
                  {m.role === "persona" && m.personaName && (
                    <div
                      style={{
                        fontSize: 10,
                        color: "#858585",
                        marginLeft: 4,
                        marginBottom: 2,
                        letterSpacing: "0.02em",
                      }}
                    >
                      {m.personaName}
                    </div>
                  )}
                  <div
                    style={{
                      maxWidth: "85%",
                      padding: "6px 10px",
                      borderRadius:
                        m.role === "candidate"
                          ? "12px 12px 2px 12px"
                          : "12px 12px 12px 2px",
                      background: m.role === "candidate" ? "#094771" : "#2d2d2d",
                      color: "#cccccc",
                      fontSize: 13,
                      lineHeight: 1.5,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {m.text}
                  </div>
                </div>
              ))}
              {awaiting[c] && (
                <div style={{ padding: "6px 12px" }}>
                  <div
                    style={{
                      display: "inline-block",
                      padding: "6px 10px",
                      borderRadius: "12px 12px 12px 2px",
                      background: "#2d2d2d",
                      color: "#555",
                      fontSize: 13,
                    }}
                  >
                    ···
                  </div>
                </div>
              )}
              <div ref={c === "client" ? clientBottom : teamBottom} />
            </div>

            {/* Input row — mirrors ChatHUD */}
            <div
              style={{
                padding: "8px 10px",
                borderTop: "1px solid #404040",
                display: "flex",
                gap: 6,
                flexShrink: 0,
                background: "#252526",
              }}
            >
              <input
                value={drafts[c]}
                onChange={(e) =>
                  setDrafts((prev) => ({ ...prev, [c]: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send(c);
                  }
                }}
                disabled={!connected || awaiting[c]}
                placeholder={
                  !connected
                    ? "Disconnected"
                    : awaiting[c]
                      ? "Waiting for reply…"
                      : c === "client"
                        ? "Message Dana…"
                        : "Message Sam…"
                }
                style={{
                  flex: 1,
                  background: !connected ? "#1e1e1e" : "#3c3c3c",
                  border: "1px solid #555",
                  borderRadius: 4,
                  color: !connected ? "#555" : "#cccccc",
                  fontSize: 13,
                  padding: "5px 8px",
                  outline: "none",
                  cursor: !connected ? "not-allowed" : "text",
                }}
              />
              <button
                onClick={() => send(c)}
                disabled={!connected || awaiting[c] || drafts[c].trim().length === 0}
                style={{
                  background:
                    connected && !awaiting[c] && drafts[c].trim().length > 0
                      ? "#0e639c"
                      : "#37373d",
                  color:
                    connected && !awaiting[c] && drafts[c].trim().length > 0
                      ? "#fff"
                      : "#555",
                  border: "none",
                  borderRadius: 4,
                  padding: "5px 12px",
                  fontSize: 13,
                  cursor:
                    connected && !awaiting[c] && drafts[c].trim().length > 0
                      ? "pointer"
                      : "not-allowed",
                  flexShrink: 0,
                }}
              >
                Send
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
