"use client";
import { useEffect, useRef, useState } from "react";
import { color, font, radius } from "@/styles/tokens";
import TabStrip, { type TabSpec } from "@/components/ui/TabStrip";
import Bubble from "@/components/ui/Bubble";
import Button from "@/components/ui/Button";
import Pill from "@/components/ui/Pill";
import { getMessageHistory, getSessionToken } from "@/lib/api";
import { useSessionStore } from "@/stores/sessionStore";

interface Props { sessionId: string; }

// Wire-level channel — unchanged. The candidate UI shows ONE chat thread for
// the two persona channels (client + team share the whole conversation
// server-side); "verifier" is the L4 end-of-session defense and keeps its own
// tab, which only appears once the reviewer first speaks.
type Channel = "client" | "team" | "verifier";
type PersonaChannel = "client" | "team";
type Tab = "chat" | "verifier";

interface ChatMessage {
  channel: PersonaChannel;   // addressee for candidate turns, author for persona turns
  role: "candidate" | "persona";
  text: string;
  personaName?: string;
  ts: string;
}

interface VerifierMessage {
  role: "candidate" | "persona";
  text: string;
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

// LEGACY fallback persona labels, used only when the session carries no
// persona data (older sessions); live labels are scenario-driven.
const FALLBACK = {
  client: { name: "Dana", role: "VP Finance" },
  team:   { name: "Sam",  role: "senior engineer" },
} as const;

const PERSONA_COLOR: Record<Channel, string> = {
  client:   color.persona.client,
  team:     color.persona.team,
  // Muted sage — on-palette but distinct from the team teal and the limes.
  verifier: color.persona.verifier,
};

const SERVER_URL = process.env["NEXT_PUBLIC_SERVER_URL"] ?? "http://localhost:3001";

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

export default function Messages({ sessionId }: Props) {
  // Personas are scenario-driven (frozen at session creation, delivered by
  // GET /sessions/:id → sessionStore). Null on older sessions → legacy labels.
  const clientPersona = useSessionStore((s) => s.scenario.clientPersona);
  const teamPersona = useSessionStore((s) => s.scenario.teamPersona);
  const personas: Record<PersonaChannel, { name: string; role: string }> = {
    client: clientPersona ?? FALLBACK.client,
    team:   teamPersona ?? FALLBACK.team,
  };

  const [active, setActive] = useState<Tab>("chat");
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [verifierThread, setVerifierThread] = useState<VerifierMessage[]>([]);
  const [recipient, setRecipient] = useState<PersonaChannel>("client");
  const [awaiting, setAwaiting] = useState<Record<Channel, boolean>>({ client: false, team: false, verifier: false });
  const [draft, setDraft] = useState("");
  const [verifierDraft, setVerifierDraft] = useState("");
  const [unread, setUnread] = useState<Record<Tab, number>>({ chat: 0, verifier: 0 });
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const activeRef = useRef<Tab>(active);
  useEffect(() => { activeRef.current = active; }, [active]);
  // WS handler reads the live draft to decide whether auto-following the
  // recipient would yank the addressee out from under a mid-composition send.
  const draftRef = useRef("");
  useEffect(() => { draftRef.current = draft; }, [draft]);

  const wsRef = useRef<WebSocket | null>(null);
  const chatBottom = useRef<HTMLDivElement>(null);
  const verifierBottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (active === "chat" ? chatBottom : verifierBottom).current?.scrollIntoView({ behavior: "smooth" });
  }, [active, chat, verifierThread]);

  // Hydrate persisted message history on mount/refresh, THEN open the WS.
  // Dedup guard: if a WS persona reply lands during the history fetch and
  // the same row was already persisted to events, we'd render it twice.
  // Keys stay per-channel so the semantics match the wire protocol.
  const seenKeysRef = useRef<Record<Channel, Set<string>>>({
    client: new Set(), team: new Set(), verifier: new Set(),
  });
  function msgKey(m: { text: string; ts: string }): string {
    return `${m.ts}|${m.text.slice(0, 64)}`;
  }

  useEffect(() => {
    let cancelled = false;
    seenKeysRef.current = { client: new Set(), team: new Set(), verifier: new Set() };
    // Hydrate first. History arrives seq-ordered (oldest→newest) across both
    // persona channels — exactly the unified thread. (The verifier exchange is
    // live-only over the WS.)
    getMessageHistory(sessionId)
      .then((items) => {
        if (cancelled) return;
        const next: ChatMessage[] = [];
        let lastPersonaChannel: PersonaChannel | null = null;
        for (const it of items) {
          next.push({
            channel: it.channel,
            role: it.role,
            text: it.text,
            ts: it.ts,
            ...(it.persona_name ? { personaName: it.persona_name } : {}),
          });
          seenKeysRef.current[it.channel].add(msgKey(it));
          if (it.role === "persona") lastPersonaChannel = it.channel;
        }
        setChat(next);
        // Default recipient: whoever spoke last (so replying to a proactive
        // ping goes to the right persona).
        if (lastPersonaChannel) setRecipient(lastPersonaChannel);
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
        setAwaiting({ client: false, team: false, verifier: false });
        return;
      }
      const channel = parsed.channel;
      const key = msgKey({ text: parsed.text, ts: parsed.ts });
      if (seenKeysRef.current[channel].has(key)) {
        setAwaiting((prev) => ({ ...prev, [channel]: false }));
        return;
      }
      seenKeysRef.current[channel].add(key);

      if (channel === "verifier") {
        setVerifierThread((prev) => [...prev, { role: "persona", text: parsed.text, ts: parsed.ts }]);
        setAwaiting((prev) => ({ ...prev, verifier: false }));
        if (activeRef.current !== "verifier") {
          setUnread((prev) => ({ ...prev, verifier: prev.verifier + 1 }));
        }
        return;
      }

      setChat((prev) => [
        ...prev,
        { channel, role: "persona", text: parsed.text, personaName: parsed.persona_name, ts: parsed.ts },
      ]);
      setAwaiting((prev) => ({ ...prev, [channel]: false }));
      // Auto-follow the conversation: replying to whoever just spoke is the
      // common case — but never mid-composition.
      if (draftRef.current.trim().length === 0) setRecipient(channel);
      if (activeRef.current !== "chat") {
        setUnread((prev) => ({ ...prev, chat: prev.chat + 1 }));
      }
    });
    ws.addEventListener("close", () => setConnected(false));
    ws.addEventListener("error", () => { setError("Messaging connection error."); setConnected(false); });

    return () => { try { ws.close(); } catch { /* already closing */ } };
  }, [sessionId]);

  function sendChat() {
    const text = draft.trim();
    if (!text || awaiting[recipient] || !wsRef.current || wsRef.current.readyState !== 1) return;
    setChat((prev) => [
      ...prev,
      { channel: recipient, role: "candidate", text, ts: new Date().toISOString() },
    ]);
    setDraft("");
    setAwaiting((prev) => ({ ...prev, [recipient]: true }));
    setError(null);
    wsRef.current.send(JSON.stringify({ channel: recipient, text }));
  }

  function sendVerifier() {
    const text = verifierDraft.trim();
    if (!text || awaiting.verifier || !wsRef.current || wsRef.current.readyState !== 1) return;
    setVerifierThread((prev) => [...prev, { role: "candidate", text, ts: new Date().toISOString() }]);
    setVerifierDraft("");
    setAwaiting((prev) => ({ ...prev, verifier: true }));
    setError(null);
    wsRef.current.send(JSON.stringify({ channel: "verifier", text }));
  }

  // The verifier tab is hidden until the reviewer first speaks (or it's active).
  const showVerifier = verifierThread.length > 0 || active === "verifier";
  const tabs: TabSpec<Tab>[] = [
    { id: "chat", label: "Chat", badge: active !== "chat" && unread.chat > 0 ? unread.chat : null },
    ...(showVerifier
      ? [{
          id: "verifier" as Tab,
          label: "Reviewer",
          badge: active !== "verifier" && unread.verifier > 0 ? unread.verifier : null,
        }]
      : []),
  ];

  function switchTo(t: Tab) {
    setActive(t);
    if (unread[t] > 0) setUnread((prev) => ({ ...prev, [t]: 0 }));
  }

  const composerStyle = {
    flex: 1,
    background: color.bg.input,
    border: `1px solid ${color.border.default}`,
    borderRadius: radius.sm,
    color: color.text.primary,
    fontFamily: font.sans,
    fontSize: 13,
    padding: "7px 10px",
    outline: "none",
    resize: "vertical",
    lineHeight: 1.5,
    minHeight: 34,
    maxHeight: 120,
  } as const;

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
        {/* ── Unified chat: both personas, one thread ─────────────────────── */}
        <div style={{
          position: "absolute", inset: 0,
          display: active === "chat" ? "flex" : "none",
          flexDirection: "column",
        }}>
          <div style={{
            padding: "8px 16px",
            background: color.bg.panel,
            borderBottom: `1px solid ${color.border.subtle}`,
            fontSize: 12, color: color.text.muted,
            flexShrink: 0,
          }}>
            <span style={{ color: PERSONA_COLOR.client }}>●</span>{" "}
            {personas.client.name}, {personas.client.role}
            {"   ·   "}
            <span style={{ color: PERSONA_COLOR.team }}>●</span>{" "}
            {personas.team.name}, {personas.team.role}
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
            {chat.length === 0 && (
              <div style={{ color: color.text.muted, fontSize: 12, textAlign: "center", padding: "32px 12px", lineHeight: 1.6 }}>
                One channel, everyone in it — message your client ({personas.client.name}) or your teammate ({personas.team.name}). Pick who you&apos;re talking to below.
              </div>
            )}
            {chat.map((m, i) => (
              <Bubble
                key={i}
                role={m.role === "candidate" ? "self" : "other"}
                label={
                  m.role === "persona"
                    ? `${m.personaName ?? personas[m.channel].name} — ${personas[m.channel].role}`
                    : `→ ${personas[m.channel].name}`
                }
                accentColor={m.role === "persona" ? PERSONA_COLOR[m.channel] : color.persona.candidate}
                timestamp={fmtTime(m.ts)}
              >
                {m.text}
              </Bubble>
            ))}
            {(["client", "team"] as const).filter((c) => awaiting[c]).map((c) => (
              <Bubble key={`awaiting-${c}`} role="other" accentColor={PERSONA_COLOR[c]} label={personas[c].name}>
                <span style={{ color: color.text.muted, fontSize: 13 }}>···</span>
              </Bubble>
            ))}
            <div ref={chatBottom} />
          </div>

          <div style={{
            padding: "10px 12px",
            borderTop: `1px solid ${color.border.subtle}`,
            display: "flex", flexDirection: "column", gap: 8, flexShrink: 0,
            background: color.bg.panel,
          }}>
            {/* Recipient toggle — decides which persona replies. */}
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, color: color.text.muted, fontFamily: font.mono, letterSpacing: "0.06em" }}>TO:</span>
              {(["client", "team"] as const).map((c) => {
                const selected = recipient === c;
                return (
                  <button
                    key={c}
                    onClick={() => setRecipient(c)}
                    style={{
                      background: selected ? `${PERSONA_COLOR[c]}22` : "transparent",
                      border: `1px solid ${selected ? PERSONA_COLOR[c] : color.border.default}`,
                      borderRadius: radius.sm,
                      color: selected ? color.text.primary : color.text.secondary,
                      fontFamily: font.sans,
                      fontSize: 12,
                      padding: "3px 10px",
                      cursor: "pointer",
                      display: "inline-flex", alignItems: "center", gap: 6,
                    }}
                  >
                    <span style={{ color: PERSONA_COLOR[c], fontSize: 9 }}>●</span>
                    {personas[c].name}
                  </button>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {/* textarea (not input) so Shift+Enter inserts a newline; Enter sends. */}
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
                disabled={!connected || awaiting[recipient]}
                placeholder={
                  !connected ? "Disconnected"
                  : awaiting[recipient] ? `Waiting for ${personas[recipient].name}…`
                  : `Message ${personas[recipient].name}…`
                }
                rows={1}
                style={{ ...composerStyle, cursor: !connected ? "not-allowed" : "text" }}
              />
              <Button
                variant="primary"
                size="md"
                disabled={!connected || awaiting[recipient] || draft.trim().length === 0}
                onClick={sendChat}
              >
                Send
              </Button>
            </div>
          </div>
        </div>

        {/* ── Reviewer (L4 defense) — unchanged separate tab ──────────────── */}
        <div style={{
          position: "absolute", inset: 0,
          display: active === "verifier" ? "flex" : "none",
          flexDirection: "column",
        }}>
          <div style={{
            padding: "8px 16px",
            background: color.bg.panel,
            borderBottom: `1px solid ${color.border.subtle}`,
            fontSize: 12, color: color.text.muted,
            flexShrink: 0,
          }}>
            End-of-session check — defend your key decisions
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
            {verifierThread.length === 0 && (
              <div style={{ color: color.text.muted, fontSize: 12, textAlign: "center", padding: "32px 12px", lineHeight: 1.6 }}>
                The reviewer will ask you to defend a few key decisions before the session ends.
              </div>
            )}
            {verifierThread.map((m, i) => (
              <Bubble
                key={i}
                role={m.role === "candidate" ? "self" : "other"}
                label={m.role === "persona" ? "Reviewer" : undefined}
                accentColor={m.role === "persona" ? PERSONA_COLOR.verifier : color.persona.candidate}
                timestamp={fmtTime(m.ts)}
              >
                {m.text}
              </Bubble>
            ))}
            {awaiting.verifier && (
              <Bubble role="other" accentColor={PERSONA_COLOR.verifier} label="Reviewer">
                <span style={{ color: color.text.muted, fontSize: 13 }}>···</span>
              </Bubble>
            )}
            <div ref={verifierBottom} />
          </div>

          <div style={{
            padding: "10px 12px",
            borderTop: `1px solid ${color.border.subtle}`,
            display: "flex", gap: 8, flexShrink: 0,
            background: color.bg.panel,
          }}>
            <textarea
              value={verifierDraft}
              onChange={(e) => setVerifierDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendVerifier(); } }}
              disabled={!connected || awaiting.verifier}
              placeholder={
                !connected ? "Disconnected"
                : awaiting.verifier ? "Waiting for reply…"
                : "Answer the reviewer…"
              }
              rows={1}
              style={{ ...composerStyle, cursor: !connected ? "not-allowed" : "text" }}
            />
            <Button
              variant="primary"
              size="md"
              disabled={!connected || awaiting.verifier || verifierDraft.trim().length === 0}
              onClick={sendVerifier}
            >
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
