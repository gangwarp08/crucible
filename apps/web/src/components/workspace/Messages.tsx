"use client";
import { useEffect, useRef, useState } from "react";
import { color, font, radius } from "@/styles/tokens";
import TabStrip, { type TabSpec } from "@/components/ui/TabStrip";
import Bubble from "@/components/ui/Bubble";
import Button from "@/components/ui/Button";
import Pill from "@/components/ui/Pill";
import { getMessageHistory } from "@/lib/api";

interface Props { sessionId: string; }

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

const PERSONA_COLOR: Record<Channel, string> = {
  client: color.persona.client,
  team:   color.persona.team,
};

const SERVER_URL = process.env["NEXT_PUBLIC_SERVER_URL"] ?? "http://localhost:3001";

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

export default function Messages({ sessionId }: Props) {
  const [active, setActive] = useState<Channel>("client");
  const [threads, setThreads] = useState<Record<Channel, PersonaMessage[]>>({ client: [], team: [] });
  const [awaiting, setAwaiting] = useState<Record<Channel, boolean>>({ client: false, team: false });
  const [drafts, setDrafts] = useState<Record<Channel, string>>({ client: "", team: "" });
  const [unread, setUnread] = useState<Record<Channel, number>>({ client: 0, team: 0 });
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const activeRef = useRef<Channel>(active);
  useEffect(() => { activeRef.current = active; }, [active]);

  const wsRef = useRef<WebSocket | null>(null);
  const clientBottom = useRef<HTMLDivElement>(null);
  const teamBottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const r = active === "client" ? clientBottom : teamBottom;
    r.current?.scrollIntoView({ behavior: "smooth" });
  }, [active, threads]);

  // Hydrate persisted message history on mount/refresh, THEN open the WS.
  // Dedup guard: if a WS persona reply lands during the history fetch and
  // the same row was already persisted to events, we'd render it twice.
  // Keep a per-channel set of `${ts}|${textHead}` keys for the in-flight
  // window and skip WS pushes that match.
  const seenKeysRef = useRef<Record<Channel, Set<string>>>({
    client: new Set(),
    team:   new Set(),
  });
  function msgKey(channel: Channel, m: { text: string; ts: string }): string {
    return `${m.ts}|${m.text.slice(0, 64)}`;
  }

  useEffect(() => {
    let cancelled = false;
    seenKeysRef.current = { client: new Set(), team: new Set() };
    // Hydrate first.
    getMessageHistory(sessionId)
      .then((items) => {
        if (cancelled) return;
        const next: Record<Channel, PersonaMessage[]> = { client: [], team: [] };
        for (const it of items) {
          const msg: PersonaMessage = {
            role: it.role,
            text: it.text,
            ts: it.ts,
            ...(it.persona_name ? { personaName: it.persona_name } : {}),
          };
          next[it.channel].push(msg);
          seenKeysRef.current[it.channel].add(msgKey(it.channel, it));
        }
        setThreads(next);
      })
      .catch(() => { /* tolerate — fall back to empty + WS-only */ });
    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    const wsBase = SERVER_URL.replace(/^http/, "ws");
    const ws = new WebSocket(`${wsBase}/messages/${sessionId}`);
    wsRef.current = ws;

    ws.addEventListener("open", () => { setConnected(true); setError(null); });
    ws.addEventListener("message", (ev) => {
      let parsed: Inbound;
      try { parsed = JSON.parse(typeof ev.data === "string" ? ev.data : "") as Inbound; }
      catch { return; }
      if (parsed.type === "error") {
        setError(parsed.message);
        setAwaiting({ client: false, team: false });
        return;
      }
      const key = msgKey(parsed.channel, { text: parsed.text, ts: parsed.ts });
      if (seenKeysRef.current[parsed.channel].has(key)) {
        // history hydration already covered this row — skip dup.
        setAwaiting((prev) => ({ ...prev, [parsed.channel]: false }));
        return;
      }
      seenKeysRef.current[parsed.channel].add(key);
      setThreads((prev) => ({
        ...prev,
        [parsed.channel]: [
          ...prev[parsed.channel],
          { role: "persona", text: parsed.text, personaName: parsed.persona_name, ts: parsed.ts },
        ],
      }));
      setAwaiting((prev) => ({ ...prev, [parsed.channel]: false }));
      if (parsed.channel !== activeRef.current) {
        setUnread((prev) => ({ ...prev, [parsed.channel]: prev[parsed.channel] + 1 }));
      }
    });
    ws.addEventListener("close", () => setConnected(false));
    ws.addEventListener("error", () => { setError("Messaging connection error."); setConnected(false); });

    return () => { try { ws.close(); } catch { /* already closing */ } };
  }, [sessionId]);

  function send(channel: Channel) {
    const draft = drafts[channel].trim();
    if (!draft || awaiting[channel] || !wsRef.current || wsRef.current.readyState !== 1) return;
    const optimistic: PersonaMessage = { role: "candidate", text: draft, ts: new Date().toISOString() };
    setThreads((prev) => ({ ...prev, [channel]: [...prev[channel], optimistic] }));
    setDrafts((prev) => ({ ...prev, [channel]: "" }));
    setAwaiting((prev) => ({ ...prev, [channel]: true }));
    setError(null);
    wsRef.current.send(JSON.stringify({ channel, text: draft }));
  }

  const tabs: TabSpec<Channel>[] = (["client", "team"] as const).map((c) => ({
    id: c,
    label: CHANNEL_META[c].label,
    badge: c !== active && unread[c] > 0 ? unread[c] : null,
  }));

  function switchTo(c: Channel) {
    setActive(c);
    if (unread[c] > 0) setUnread((prev) => ({ ...prev, [c]: 0 }));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: color.bg.page, overflow: "hidden" }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "6px 10px", background: color.bg.elevated, borderBottom: `1px solid ${color.border.subtle}`,
        flexShrink: 0,
      }}>
        <TabStrip tabs={tabs} value={active} onChange={switchTo} variant="pill" />
        {!connected && <Pill tone="warn">disconnected</Pill>}
      </div>

      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
        {(["client", "team"] as const).map((c) => (
          <div
            key={c}
            style={{
              position: "absolute", inset: 0,
              display: active === c ? "flex" : "none",
              flexDirection: "column",
            }}
          >
            <div style={{
              padding: "8px 16px",
              background: color.bg.panel,
              borderBottom: `1px solid ${color.border.subtle}`,
              fontSize: 12, color: color.text.muted,
              flexShrink: 0,
            }}>
              {CHANNEL_META[c].sublabel}
            </div>

            {error && (
              <div style={{
                padding: "10px 14px", background: color.error.soft, color: color.error.base,
                fontSize: 12, flexShrink: 0, borderBottom: `1px solid ${color.border.subtle}`,
              }}>
                {error}
              </div>
            )}

            <div style={{
              flex: 1, overflowY: "auto", padding: "12px 16px",
              display: "flex", flexDirection: "column", gap: 10,
            }}>
              {threads[c].length === 0 && (
                <div style={{ color: color.text.muted, fontSize: 12, textAlign: "center", padding: "32px 12px", lineHeight: 1.6 }}>
                  {c === "client" ? "Start a conversation with the client (Dana)." : "Ping your teammate (Sam)."}
                </div>
              )}
              {threads[c].map((m, i) => (
                <Bubble
                  key={i}
                  role={m.role === "candidate" ? "self" : "other"}
                  label={m.role === "persona" ? (m.personaName ?? CHANNEL_META[c].label) : undefined}
                  accentColor={m.role === "persona" ? PERSONA_COLOR[c] : color.persona.candidate}
                  timestamp={fmtTime(m.ts)}
                >
                  {m.text}
                </Bubble>
              ))}
              {awaiting[c] && (
                <Bubble role="other" accentColor={PERSONA_COLOR[c]} label={CHANNEL_META[c].label.split(",")[0]}>
                  <span style={{ color: color.text.muted, fontSize: 13 }}>···</span>
                </Bubble>
              )}
              <div ref={c === "client" ? clientBottom : teamBottom} />
            </div>

            <div style={{
              padding: "10px 12px",
              borderTop: `1px solid ${color.border.subtle}`,
              display: "flex", gap: 8, flexShrink: 0,
              background: color.bg.panel,
            }}>
              <input
                value={drafts[c]}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [c]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(c); } }}
                disabled={!connected || awaiting[c]}
                placeholder={
                  !connected ? "Disconnected"
                  : awaiting[c] ? "Waiting for reply…"
                  : c === "client" ? "Message Dana…" : "Message Sam…"
                }
                style={{
                  flex: 1,
                  background: color.bg.input,
                  border: `1px solid ${color.border.default}`,
                  borderRadius: radius.sm,
                  color: color.text.primary,
                  fontFamily: font.sans,
                  fontSize: 13,
                  padding: "7px 10px",
                  outline: "none",
                  cursor: !connected ? "not-allowed" : "text",
                }}
              />
              <Button
                variant="primary"
                size="md"
                disabled={!connected || awaiting[c] || drafts[c].trim().length === 0}
                onClick={() => send(c)}
              >
                Send
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
