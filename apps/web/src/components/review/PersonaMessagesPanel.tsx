"use client";
// Persona-channel conversation view for the recruiter review page: the
// candidate's chat with the TEAM persona and the CLIENT persona, rebuilt from
// the session's `message.{team|client}.{candidate|persona}` event rows (the
// detail endpoint already returns every event, so no extra fetch). One tab
// per channel, speaker-labeled and timestamped bubbles — same visual idiom as
// TranscriptPanel. Renders nothing when the session has no persona messages
// (e.g. scenarios without personas), mirroring SuspicionPanel's posture.
import { useMemo, useState } from "react";
import type { ReviewEvent } from "@/lib/api";
import { color, radius, font } from "@/styles/tokens";
import { formatDateTime } from "./format";

type Channel = "team" | "client";
const CHANNELS: Channel[] = ["team", "client"];
const CHANNEL_LABEL: Record<Channel, string> = { team: "Team", client: "Client" };

interface PersonaMessage {
  seq: number;
  channel: Channel;
  role: "candidate" | "persona";
  /** Persona display name when the server recorded one (persona rows only). */
  personaName: string | null;
  text: string;
  ts: string;
}

/** Parse `message.{channel}.{role}` event rows into typed messages; anything
 *  malformed (wrong channel/role, missing text) is skipped, same tolerance as
 *  the server's own history endpoint (routes/messages.ts). */
function parseMessages(events: ReviewEvent[]): PersonaMessage[] {
  const out: PersonaMessage[] = [];
  for (const e of events) {
    const parts = e.type.split(".");
    if (parts.length !== 3 || parts[0] !== "message") continue;
    const channel = parts[1];
    const role = parts[2];
    if (channel !== "team" && channel !== "client") continue;
    if (role !== "candidate" && role !== "persona") continue;
    const p: Record<string, unknown> = e.payload ?? {};
    const text = p["text"];
    if (typeof text !== "string") continue;
    out.push({
      seq: e.seq,
      channel,
      role,
      personaName:
        role === "persona" && typeof p["persona_name"] === "string" ? p["persona_name"] : null,
      text,
      ts: e.ts,
    });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

function Bubble({ msg }: { msg: PersonaMessage }) {
  const isCandidate = msg.role === "candidate";
  const speaker = isCandidate
    ? "Candidate"
    : (msg.personaName ?? CHANNEL_LABEL[msg.channel]);
  return (
    <div
      style={{
        padding: "8px 16px",
        display: "flex",
        flexDirection: "column",
        alignItems: isCandidate ? "flex-end" : "flex-start",
        gap: 4,
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: color.text.muted,
          fontFamily: font.mono,
          display: "flex",
          gap: 8,
        }}
      >
        <span style={{ color: color.text.secondary, fontWeight: 600 }}>{speaker}</span>
        <span>{formatDateTime(msg.ts)}</span>
      </div>
      <div
        style={{
          maxWidth: "85%",
          padding: "8px 12px",
          borderRadius: isCandidate
            ? `${radius.md} ${radius.md} ${radius.sm} ${radius.md}`
            : `${radius.md} ${radius.md} ${radius.md} ${radius.sm}`,
          background: isCandidate ? color.accent.soft : color.bg.elevated,
          color: color.text.primary,
          fontSize: 13,
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {msg.text}
      </div>
    </div>
  );
}

export default function PersonaMessagesPanel({ events }: { events: ReviewEvent[] }) {
  const messages = useMemo(() => parseMessages(events), [events]);
  const channelsWithMessages = CHANNELS.filter((c) =>
    messages.some((m) => m.channel === c),
  );
  const [selected, setSelected] = useState<Channel | null>(null);

  // No persona traffic at all (persona-less scenario / legacy session) —
  // stay invisible rather than render an empty shell.
  if (channelsWithMessages.length === 0) return null;

  const active: Channel =
    selected !== null && channelsWithMessages.includes(selected)
      ? selected
      : channelsWithMessages[0]!;
  const activeMessages = messages.filter((m) => m.channel === active);

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
          gap: 12,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: color.text.secondary, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Persona Messages
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          {CHANNELS.map((c) => {
            const count = messages.filter((m) => m.channel === c).length;
            const isActive = c === active;
            return (
              <button
                key={c}
                onClick={() => setSelected(c)}
                disabled={count === 0}
                style={{
                  padding: "3px 10px",
                  fontSize: 11,
                  borderRadius: radius.sm,
                  border: `1px solid ${isActive ? color.accent.base : color.border.default}`,
                  background: isActive ? color.accent.soft : "transparent",
                  color: count === 0 ? color.text.muted : isActive ? color.text.primary : color.text.secondary,
                  cursor: count === 0 ? "default" : "pointer",
                  fontFamily: font.mono,
                }}
              >
                {CHANNEL_LABEL[c]} ({count})
              </button>
            );
          })}
        </div>
      </header>

      <div style={{ padding: "12px 0", maxHeight: 480, overflowY: "auto" }}>
        {activeMessages.length === 0 ? (
          <div style={{ padding: "24px 16px", color: color.text.muted, fontSize: 13, textAlign: "center" }}>
            No messages on this channel
          </div>
        ) : (
          activeMessages.map((m) => <Bubble key={m.seq} msg={m} />)
        )}
      </div>
    </section>
  );
}
