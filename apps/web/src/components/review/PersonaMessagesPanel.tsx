"use client";
// Persona conversation view for the recruiter review page: the candidate's
// chat with the CLIENT and TEAM personas, rebuilt from the session's
// `message.{team|client}.{candidate|persona}` event rows (the detail endpoint
// already returns every event, so no extra fetch). Rendered as ONE seq-sorted
// interleaved thread — the same unified chat the candidate saw — with
// candidate rows labeled by addressee ("Candidate → Dana") and persona rows by
// name. Renders nothing when the session has no persona messages (e.g.
// scenarios without personas), mirroring SuspicionPanel's posture.
import { useMemo } from "react";
import type { ReviewEvent } from "@/lib/api";
import { color, radius, font } from "@/styles/tokens";
import { formatDateTime } from "./format";

type Channel = "team" | "client";
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

/** Per-channel persona display names, harvested from the persona rows
 *  themselves so candidate rows can be labeled "Candidate → Dana" without any
 *  extra scenario fetch. Falls back to the channel label. */
function personaNames(messages: PersonaMessage[]): Record<Channel, string> {
  const names: Record<Channel, string> = { team: CHANNEL_LABEL.team, client: CHANNEL_LABEL.client };
  for (const m of messages) {
    if (m.role === "persona" && m.personaName) names[m.channel] = m.personaName;
  }
  return names;
}

const CHANNEL_ACCENT: Record<Channel, string> = {
  client: color.persona.client,
  team: color.persona.team,
};

function Bubble({ msg, names }: { msg: PersonaMessage; names: Record<Channel, string> }) {
  const isCandidate = msg.role === "candidate";
  const speaker = isCandidate
    ? `Candidate → ${names[msg.channel]}`
    : (msg.personaName ?? names[msg.channel]);
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
        <span
          style={{
            color: isCandidate ? color.text.secondary : CHANNEL_ACCENT[msg.channel],
            fontWeight: 600,
          }}
        >
          {speaker}
        </span>
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
  const names = useMemo(() => personaNames(messages), [messages]);

  // No persona traffic at all (persona-less scenario / legacy session) —
  // stay invisible rather than render an empty shell.
  if (messages.length === 0) return null;

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
        <span style={{ fontSize: 11, color: color.text.muted, fontFamily: font.mono }}>
          {messages.length} messages ·{" "}
          <span style={{ color: CHANNEL_ACCENT.client }}>{names.client}</span>
          {" + "}
          <span style={{ color: CHANNEL_ACCENT.team }}>{names.team}</span>
        </span>
      </header>

      <div style={{ padding: "12px 0", maxHeight: 480, overflowY: "auto" }}>
        {messages.map((m) => (
          <Bubble key={m.seq} msg={m} names={names} />
        ))}
      </div>
    </section>
  );
}
