"use client";
import { useState, useRef, useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { sendChat, type ChatError } from "@/lib/api";

function isChatError(r: object): r is ChatError {
  return "error" in r;
}

export default function ChatHUD() {
  const { sessionId, status, addMessage, setSpendBudget, setStatus } =
    useSessionStore();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const messages = useSessionStore((s) => s.messages);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new messages.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
          if (res.spend !== undefined && res.budget !== undefined) {
            setSpendBudget(res.spend, res.budget);
          }
        } else if (res.error === "session_ended") {
          setStatus("ended");
        } else {
          addMessage({ role: "assistant", text: `Error: ${res.message}` });
        }
      } else {
        addMessage({ role: "assistant", text: res.reply });
        setSpendBudget(res.spend, res.budget);
      }
    } catch {
      addMessage({ role: "assistant", text: "Network error — please retry." });
    } finally {
      setSending(false);
    }
  }

  const disabled = status !== "active";
  const placeholderText =
    status === "budget_exhausted"
      ? "Budget reached"
      : status === "ended"
        ? "Session ended"
        : sending
          ? "Waiting for response…"
          : "Ask the AI interviewer…";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#1e1e1e",
        borderTop: "1px solid #404040",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "5px 12px",
          background: "#2d2d2d",
          borderBottom: "1px solid #404040",
          fontSize: 12,
          color: "#858585",
          userSelect: "none",
          letterSpacing: "0.04em",
          flexShrink: 0,
        }}
      >
        AI INTERVIEWER
      </div>

      {/* Status banner */}
      {status !== "active" && (
        <div
          style={{
            padding: "8px 12px",
            background: status === "ended" ? "#37373d" : "#4b2020",
            color: status === "ended" ? "#cccccc" : "#f48771",
            fontSize: 12,
            textAlign: "center",
            flexShrink: 0,
          }}
        >
          {status === "ended"
            ? "Session has ended. Sandbox and keys have been revoked."
            : "Budget exhausted. Session closed."}
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
        {messages.length === 0 && (
          <div
            style={{
              color: "#555",
              fontSize: 12,
              textAlign: "center",
              padding: "24px 12px",
              lineHeight: 1.5,
            }}
          >
            Ask a question or request a hint.
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              padding: "6px 12px",
              display: "flex",
              flexDirection: "column",
              alignItems: msg.role === "user" ? "flex-end" : "flex-start",
            }}
          >
            <div
              style={{
                maxWidth: "85%",
                padding: "6px 10px",
                borderRadius: msg.role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
                background: msg.role === "user" ? "#094771" : "#2d2d2d",
                color: "#cccccc",
                fontSize: 13,
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {msg.text}
            </div>
          </div>
        ))}
        {sending && (
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
        <div ref={bottomRef} />
      </div>

      {/* Input row */}
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
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          disabled={disabled}
          placeholder={placeholderText}
          style={{
            flex: 1,
            background: disabled ? "#1e1e1e" : "#3c3c3c",
            border: "1px solid #555",
            borderRadius: 4,
            color: disabled ? "#555" : "#cccccc",
            fontSize: 13,
            padding: "5px 8px",
            outline: "none",
            cursor: disabled ? "not-allowed" : "text",
          }}
        />
        <button
          onClick={() => { void handleSend(); }}
          disabled={!canSend}
          style={{
            background: canSend ? "#0e639c" : "#37373d",
            color: canSend ? "#fff" : "#555",
            border: "none",
            borderRadius: 4,
            padding: "5px 12px",
            fontSize: 13,
            cursor: canSend ? "pointer" : "not-allowed",
            flexShrink: 0,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
