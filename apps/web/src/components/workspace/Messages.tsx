"use client";
import { useEffect, useRef, useState } from "react";
import { color, font, radius } from "@/styles/tokens";
import TabStrip, { type TabSpec } from "@/components/ui/TabStrip";
import Bubble from "@/components/ui/Bubble";
import Button from "@/components/ui/Button";
import Pill from "@/components/ui/Pill";
import { getMessageHistory, getSessionToken } from "@/lib/api";

interface Props { sessionId: string; }

// "verifier" is the L4 end-of-session defense channel (Slice 5.4b). Its tab only
// appears once the reviewer first speaks — candidates aren't shown an empty
// Reviewer tab during normal work.
type Channel = "client" | "team" | "verifier";

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
      role: "persona" | "verifier";
      persona_name: string;
      text: string;
      ts: string;
    }
  | { type: "error"; code: string; message: string };

const CHANNEL_META: Record<Channel, { label: string; sublabel: string }> = {
  client:   { label: "Client",   sublabel: "Dana, VP Finance" },
  team:     { label: "Team",     sublabel: "Sam, senior engineer" },
  verifier: { label: "Reviewer", sublabel: "End-of-session check — defend your key decisions" },
};

const PERSONA_COLOR: Record<Channel, string> = {
  client:   color.persona.client,
  team:     color.persona.team,
  // Muted sage — on-palette but distinct from the team teal and the limes.
  verifier: color.persona.verifier,
};

const ALL_CHANNELS = ["client", "team", "verifier"] as const;

const SERVER_URL = process.env["NEXT_PUBLIC_SERVER_URL"] ?? "http://localhost:3001";

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

function emptyByChannel<T>(make: () => T): Record<Channel, T> {
  return { client: make(), team: make(), verifier: make() };
}

export default function Messages({ sessionId }: Props) {
  const [active, setActive] = useState<Channel>("client");
  const [threads, setThreads] = useState<Record<Channel, PersonaMessage[]>>(emptyByChannel(() => []));
  const [awaiting, setAwaiting] = useState<Record<Channel, boolean>>(emptyByChannel(() => false));
  const [drafts, setDrafts] = useState<Record<Channel, string>>(emptyByChannel(() => ""));
  const [unread, setUnread] = useState<Record<Channel, number>>(emptyByChannel(() => 0));
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const activeRef = useRef<Channel>(active);
  useEffect(() => { activeRef.current = active; }, [active]);

  const wsRef = useRef<WebSocket | null>(null);
  const clientBottom = useRef<HTMLDivElement>(null);
  const teamBottom = useRef<HTMLDivElement>(null);
  const verifierBottom = useRef<HTMLDivElement>(null);
  const bottomRef = {
    client: clientBottom,
    team: teamBottom,
    verifier: verifierBottom,
  } as const;

  useEffect(() => {
    bottomRef[active].current?.scrollIntoView({ behavior: "smooth" });
  }, [active, threads]);

  // Hydrate persisted message history on mount/refresh, THEN open the WS.
  // Dedup guard: if a WS persona reply lands during the history fetch and
  // the same row was already persisted to events, we'd render it twice.
  const seenKeysRef = useRef<Record<Channel, Set<string>>>(emptyByChannel(() => new Set<string>()));
  function msgKey(_channel: Channel, m: { text: string; ts: string }): string {
    return `${m.ts}|${m.text.slice(0, 64)}`;
  }

  useEffect(() => {
    let cancelled = false;
    seenKeysRef.current = emptyByChannel(() => new Set<string>());
    // Hydrate first. (History only carries client/team persona chat; the
    // verifier exchange is live-only over the WS.)
    getMessageHistory(sessionId)
      .then((items) => {
        if (cancelled) return;
        const next: Record<Channel, PersonaMessage[]> = emptyByChannel(() => []);
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
    const token = getSessionToken(sessionId);
    const protocols = token ? [`bearer.${token}`] : undefined;
    const ws = new WebSocket(`${wsBase}/messages/${sessionId}`, protocols);
    wsRef.current = ws;

    ws.addEventListener("open", () => { setConnected(true); setError(null); });
    ws.addEventListener("message", (ev) => {
      let parsed: Inbound;
      try { parsed = JSON.parse(typeof ev.data === "string" ? ev.data : "") as Inbound; }
      catch { return; }
      if (parsed.type === "error") {
        setError(parsed.message);
        setAwaiting(emptyByChannel(() => false));
        return;
      }
      const channel = parsed.channel;
      const key = msgKey(channel, { text: parsed.text, ts: parsed.ts });
      if (seenKeysRef.current[channel].has(key)) {
        setAwaiting((prev) => ({ ...prev, [channel]: false }));
        return;
      }
      seenKeysRef.current[channel].add(key);
      setThreads((prev) => ({
        ...prev,
        [channel]: [
          ...prev[channel],
          { role: "persona", text: parsed.text, personaName: parsed.persona_name, ts: parsed.ts },
        ],
      }));
      setAwaiting((prev) => ({ ...prev, [channel]: false }));
      if (channel !== activeRef.current) {
        setUnread((prev) => ({ ...prev, [channel]: prev[channel] + 1 }));
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

  // The verifier tab is hidden until the reviewer first speaks (or it's active).
  const showVerifier = threads.verifier.length > 0 || active === "verifier";
  const visibleChannels = ALL_CHANNELS.filter((c) => c !== "verifier" || showVerifier);

  const tabs: TabSpec<Channel>[] = visibleChannels.map((c) => ({
    id: c,
    label: CHANNEL_META[c].label,
    badge: c !== active && unread[c] > 0 ? unread[c] : null,
  }));

  function switchTo(c: Channel) {
    setActive(c);
    if (unread[c] > 0) setUnread((prev) => ({ ...prev, [c]: 0 }));
  }

  function emptyHint(c: Channel): string {
    if (c === "client") return "Start a conversation with the client (Dana).";
    if (c === "team") return "Ping your teammate (Sam).";
    return "The reviewer will ask you to defend a few key decisions before the session ends.";
  }
  function placeholder(c: Channel): string {
    if (!connected) return "Disconnected";
    if (awaiting[c]) return "Waiting for reply…";
    if (c === "client") return "Message Dana…";
    if (c === "team") return "Message Sam…";
    return "Answer the reviewer…";
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
        {visibleChannels.map((c) => (
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
                  {emptyHint(c)}
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
                <Bubble role="other" accentColor={PERSONA_COLOR[c]} label={CHANNEL_META[c].label}>
                  <span style={{ color: color.text.muted, fontSize: 13 }}>···</span>
                </Bubble>
              )}
              <div ref={bottomRef[c]} />
            </div>

            <div style={{
              padding: "10px 12px",
              borderTop: `1px solid ${color.border.subtle}`,
              display: "flex", gap: 8, flexShrink: 0,
              background: color.bg.panel,
            }}>
              {/* textarea (not input) so Shift+Enter inserts a newline; Enter sends. */}
              <textarea
                value={drafts[c]}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [c]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(c); } }}
                disabled={!connected || awaiting[c]}
                placeholder={placeholder(c)}
                rows={1}
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
                  resize: "vertical",
                  lineHeight: 1.5,
                  minHeight: 34,
                  maxHeight: 120,
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
