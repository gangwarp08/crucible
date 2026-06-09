"use client";
import { useState, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import FileTree from "./FileTree";
import SessionStatus from "./SessionStatus";
import { readFile, getSession } from "@/lib/api";
import { useSessionStore } from "@/stores/sessionStore";

const Editor = dynamic(() => import("./Editor"), { ssr: false });
const Terminal = dynamic(() => import("./Terminal"), { ssr: false });
const ChatHUD = dynamic(() => import("./ChatHUD"), { ssr: false });
const DataExplorer = dynamic(() => import("./DataExplorer"), { ssr: false });
const Messages = dynamic(() => import("./Messages"), { ssr: false });

type RightTab = "terminal" | "data" | "messages";

const TAB_LABEL: Record<RightTab, string> = {
  terminal: "Terminal",
  data: "Data Explorer",
  messages: "Messages",
};

interface Props {
  sessionId: string;
}

export default function Workspace({ sessionId }: Props) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [rightTab, setRightTab] = useState<RightTab>("terminal");

  const { init, setStatus, status } = useSessionStore();

  // On mount: fetch session metadata to initialize the store (deadline, budget, spend).
  useEffect(() => {
    getSession(sessionId)
      .then((s) => {
        init(sessionId, s.deadline, s.budget, s.spend);
        if (s.status === "completed") setStatus("ended");
      })
      .catch(() => { /* server may be starting — workspace still usable */ });
  }, [sessionId, init, setStatus]);

  const handleFileSelect = useCallback(
    async (path: string) => {
      setSelectedPath(path);
      try {
        const text = await readFile(sessionId, path);
        setContent(text);
      } catch {
        setContent("");
      }
    },
    [sessionId],
  );

  const handleSessionEnd = useCallback(() => {
    if (status === "active") setStatus("ended");
  }, [status, setStatus]);

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        overflow: "hidden",
        background: "#1e1e1e",
        color: "#cccccc",
        fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
      }}
    >
      {/* File tree */}
      <div
        style={{
          width: 240,
          minWidth: 240,
          background: "#252526",
          borderRight: "1px solid #404040",
          overflowY: "auto",
          flexShrink: 0,
        }}
      >
        <FileTree
          sessionId={sessionId}
          onFileSelect={(path) => { void handleFileSelect(path); }}
          selectedPath={selectedPath}
        />
      </div>

      {/* Editor */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <Editor
          sessionId={sessionId}
          path={selectedPath}
          content={content}
          onChange={setContent}
        />
      </div>

      {/* Right column: status bar + terminal + chat HUD */}
      <div
        style={{
          width: 380,
          minWidth: 380,
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid #404040",
          flexShrink: 0,
          overflow: "hidden",
        }}
      >
        {/* Budget readout + countdown */}
        <SessionStatus />

        {/* Tabbed pane (terminal | data explorer). Both children stay mounted
            so the PTY WebSocket isn't torn down on tab switch — toggle via
            display:none instead of conditional render. */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            minHeight: 0,
          }}
        >
          <div
            style={{
              display: "flex",
              background: "#2d2d2d",
              borderBottom: "1px solid #404040",
              flexShrink: 0,
              userSelect: "none",
            }}
          >
            {(["terminal", "data", "messages"] as const).map((tab) => {
              const active = rightTab === tab;
              return (
                <button
                  key={tab}
                  onClick={() => setRightTab(tab)}
                  style={{
                    padding: "6px 14px",
                    background: "transparent",
                    border: "none",
                    borderBottom: active ? "2px solid #3794ff" : "2px solid transparent",
                    color: active ? "#cccccc" : "#858585",
                    fontSize: 12,
                    fontFamily: "inherit",
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    cursor: "pointer",
                  }}
                >
                  {TAB_LABEL[tab]}
                </button>
              );
            })}
          </div>
          <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: rightTab === "terminal" ? "block" : "none",
              }}
            >
              <Terminal sessionId={sessionId} onSessionEnd={handleSessionEnd} />
            </div>
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: rightTab === "data" ? "block" : "none",
              }}
            >
              <DataExplorer sessionId={sessionId} />
            </div>
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: rightTab === "messages" ? "block" : "none",
              }}
            >
              <Messages sessionId={sessionId} />
            </div>
          </div>
        </div>

        {/* Chat HUD — fixed height at the bottom */}
        <div style={{ height: 300, flexShrink: 0 }}>
          <ChatHUD />
        </div>
      </div>
    </div>
  );
}
