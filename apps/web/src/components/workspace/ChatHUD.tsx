"use client";
import { useState, useRef, useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { sendChat, type ChatError } from "@/lib/api";
import { color, font, radius } from "@/styles/tokens";
import Bubble from "@/components/ui/Bubble";
import Button from "@/components/ui/Button";
import SectionLabel from "@/components/ui/SectionLabel";

function isChatError(r: object): r is ChatError {
  return "error" in r;
}

export default function ChatHUD() {
  const {
    sessionId, status, addMessage, setSpendBudget, setStatus, setTokensRemaining,
  } = useSessionStore();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const messages = useSessionStore((s) => s.messages);
  const tokensRemaining = useSessionStore((s) => s.tokensRemaining);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const canSend = status === "active" && !sending && input.trim().length > 0 && sessionId !== null;

  async function handleSend() {
    if (!canSend || !sessionId) return;
    const prompt = input.trim();
    setInput("");
    setSending(true);
    addMessage({ role: "user", text: prompt });
    try {
      const res = await sendChat(sessionId, prompt);
      if (isChatError(res)) {
        if (res.error === "budget_exhausted") {
          setStatus("budget_exhausted");
          if (res.spend !== undefined && res.budget !== undefined) setSpendBudget(res.spend, res.budget);
        } else if (res.error === "token_budget_exhausted") {
          setStatus("token_exhausted");
          if (res.scenarioTokensRemaining !== undefined && res.scenarioTokensRemaining !== null)
            setTokensRemaining(res.scenarioTokensRemaining);
        } else if (res.error === "session_ended") {
          setStatus("ended");
        } else {
          addMessage({ role: "assistant", text: `Error: ${res.message}` });
        }
      } else {
        addMessage({ role: "assistant", text: res.reply });
        setSpendBudget(res.spend, res.budget);
        if (res.scenarioTokensRemaining !== null) {
          setTokensRemaining(res.scenarioTokensRemaining);
          if (res.scenarioTokensRemaining <= 0) setStatus("token_exhausted");
        }
      }
    } catch {
      addMessage({ role: "assistant", text: "Network error — please retry." });
    } finally {
      setSending(false);
    }
  }

  const disabled = status !== "active";
  const placeholderText =
    status === "budget_exhausted" ? "Budget reached"
    : status === "token_exhausted" ? "Token budget reached"
    : status === "ended" ? "Session ended"
    : sending ? "Waiting for response…"
    : "Ask the AI assistant…";

  const tokensColor =
    tokensRemaining === null ? color.text.muted
    : tokensRemaining <= 0 ? color.error.base
    : tokensRemaining < 20_000 ? color.warn.base
    : color.text.muted;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: color.bg.page }}>
      <div style={{
        padding: "8px 14px",
        background: color.bg.elevated,
        borderBottom: `1px solid ${color.border.subtle}`,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}>
        <SectionLabel>AI Assistant</SectionLabel>
        {tokensRemaining !== null && (
          <span
            style={{
              fontSize: 11,
              fontFamily: font.mono,
              fontVariantNumeric: "tabular-nums",
              color: tokensColor,
            }}
            title="In-scenario AI assistant token budget. Persona chat does not deduct from this."
          >
            {Math.max(0, tokensRemaining).toLocaleString("en-US")} tokens left
          </span>
        )}
      </div>

      {status !== "active" && (
        <div style={{
          padding: "10px 14px",
          background: status === "ended" ? color.bg.elevated : color.error.soft,
          color: status === "ended" ? color.text.secondary : color.error.base,
          fontSize: 12,
          textAlign: "center",
          flexShrink: 0,
          borderBottom: `1px solid ${color.border.subtle}`,
        }}>
          {status === "ended"
            ? "Session has ended. Sandbox and keys have been revoked."
            : status === "token_exhausted"
              ? "AI assistant token budget exhausted. Work unaided from here on."
              : "Budget exhausted. Session closed."}
        </div>
      )}

      <div style={{
        flex: 1, overflowY: "auto", padding: "14px 16px",
        display: "flex", flexDirection: "column", gap: 10,
      }}>
        {messages.length === 0 && (
          <div style={{ color: color.text.muted, fontSize: 12, textAlign: "center", padding: "32px 12px", lineHeight: 1.6 }}>
            Ask a question or request a hint.
          </div>
        )}
        {messages.map((msg, i) => (
          <Bubble
            key={i}
            role={msg.role === "user" ? "self" : "other"}
            accentColor={msg.role === "user" ? color.persona.candidate : color.persona.assistant}
            label={msg.role === "user" ? undefined : "Assistant"}
          >
            {msg.text}
          </Bubble>
        ))}
        {sending && (
          <Bubble role="other" accentColor={color.persona.assistant} label="Assistant">
            <span style={{ color: color.text.muted, fontSize: 13 }}>···</span>
          </Bubble>
        )}
        <div ref={bottomRef} />
      </div>

      <div style={{
        padding: "10px 12px",
        borderTop: `1px solid ${color.border.subtle}`,
        display: "flex", gap: 8, flexShrink: 0,
        background: color.bg.panel,
      }}>
        {/* textarea (not input) so Shift+Enter inserts a newline for multi-line
            code/SQL; Enter sends. */}
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSend(); } }}
          disabled={disabled}
          placeholder={placeholderText}
          rows={1}
          style={{
            flex: 1,
            background: color.bg.input,
            border: `1px solid ${color.border.default}`,
            borderRadius: radius.sm,
            color: disabled ? color.text.muted : color.text.primary,
            fontFamily: font.sans,
            fontSize: 13,
            padding: "7px 10px",
            outline: "none",
            cursor: disabled ? "not-allowed" : "text",
            resize: "vertical",
            lineHeight: 1.5,
            minHeight: 34,
            maxHeight: 120,
          }}
        />
        <Button variant="primary" size="md" disabled={!canSend} onClick={() => { void handleSend(); }}>
          Send
        </Button>
      </div>
    </div>
  );
}
