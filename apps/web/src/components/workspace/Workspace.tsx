"use client";
import { useState, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import FileTree from "./FileTree";
import ConstraintHUD from "./ConstraintHUD";
import BriefPanel from "./BriefPanel";
import EndScreen from "./EndScreen";
import { readFile, getSession } from "@/lib/api";
import { useSessionStore } from "@/stores/sessionStore";

const Editor = dynamic(() => import("./Editor"), { ssr: false });
const Terminal = dynamic(() => import("./Terminal"), { ssr: false });
const ChatHUD = dynamic(() => import("./ChatHUD"), { ssr: false });
const DataExplorer = dynamic(() => import("./DataExplorer"), { ssr: false });
const Messages = dynamic(() => import("./Messages"), { ssr: false });
const DocsViewer = dynamic(() => import("./DocsViewer"), { ssr: false });
const DeliverablePanel = dynamic(() => import("./DeliverablePanel"), { ssr: false });

type RightTab = "brief" | "terminal" | "data" | "messages" | "assistant" | "docs" | "deliverable";

const TAB_ORDER: readonly RightTab[] = [
  "brief", "terminal", "data", "messages", "assistant", "docs", "deliverable",
] as const;

const TAB_LABEL: Record<RightTab, string> = {
  brief:       "Brief",
  terminal:    "Terminal",
  data:        "Data",
  messages:    "Messages",
  assistant:   "Assistant",
  docs:        "Docs",
  deliverable: "Deliverable",
};

interface Props {
  sessionId: string;
}

export default function Workspace({ sessionId }: Props) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  // Default to Brief on first mount so a fresh candidate sees the orientation
  // panel; subsequent tab switches stick.
  const [rightTab, setRightTab] = useState<RightTab>("brief");

  const { init, setStatus, status, scenario } = useSessionStore();

  // On mount: fetch session metadata to initialize the store.
  useEffect(() => {
    getSession(sessionId)
      .then((s) => {
        init(
          sessionId,
          s.deadline,
          s.budget,
          s.spend,
          s.scenarioTokensRemaining,
          s.scenarioBalances?.compute_minutes ?? null,
          s.scenarioConstraints,
          {
            title:      s.scenarioTitle,
            brief:      s.scenarioBrief,
            role:       s.scenarioRole,
            difficulty: s.scenarioDifficulty,
          },
        );
        if (s.status === "completed") setStatus("ended");
        // A page reload after the token budget was already drained shouldn't
        // re-enable the input — flip status immediately if the server says
        // tokens are at/below zero.
        else if (s.scenarioTokensRemaining !== null && s.scenarioTokensRemaining <= 0) {
          setStatus("token_exhausted");
        }
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
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
        background: "#1e1e1e",
        color: "#cccccc",
        fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
      }}
    >
      {/* Top scenario title row — full width, above the HUD. Renders nothing
          when this session has no scenario bound (legacy generic mode). */}
      {(scenario.title || scenario.role) && <ScenarioChrome />}

      {/* Top constraint HUD — always visible, full width. */}
      <ConstraintHUD />

      {/* Main 3-column row */}
      <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
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

        {/* Right column: 6-tab strip + always-mounted panes (display:none toggle
            so the PTY WebSocket, messaging WS, and the chat HUD state survive
            tab switches). */}
        <div
          style={{
            width: 440,
            minWidth: 440,
            display: "flex",
            flexDirection: "column",
            borderLeft: "1px solid #404040",
            flexShrink: 0,
            overflow: "hidden",
          }}
        >
          {/* Tab strip */}
          <div
            style={{
              display: "flex",
              background: "#2d2d2d",
              borderBottom: "1px solid #404040",
              flexShrink: 0,
              userSelect: "none",
              overflowX: "auto",
            }}
          >
            {TAB_ORDER.map((tab) => {
              const active = rightTab === tab;
              return (
                <button
                  key={tab}
                  onClick={() => setRightTab(tab)}
                  style={{
                    padding: "6px 12px",
                    background: "transparent",
                    border: "none",
                    borderBottom: active ? "2px solid #3794ff" : "2px solid transparent",
                    color: active ? "#cccccc" : "#858585",
                    fontSize: 11,
                    fontFamily: "inherit",
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  {TAB_LABEL[tab]}
                </button>
              );
            })}
          </div>

          {/* Content area — all panes mounted, only the active one visible. */}
          <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
            <div style={{ position: "absolute", inset: 0, display: rightTab === "brief" ? "block" : "none" }}>
              <BriefPanel />
            </div>
            <div style={{ position: "absolute", inset: 0, display: rightTab === "terminal" ? "block" : "none" }}>
              <Terminal sessionId={sessionId} onSessionEnd={handleSessionEnd} />
            </div>
            <div style={{ position: "absolute", inset: 0, display: rightTab === "data" ? "block" : "none" }}>
              <DataExplorer sessionId={sessionId} />
            </div>
            <div style={{ position: "absolute", inset: 0, display: rightTab === "messages" ? "block" : "none" }}>
              <Messages sessionId={sessionId} />
            </div>
            <div style={{ position: "absolute", inset: 0, display: rightTab === "assistant" ? "block" : "none" }}>
              <ChatHUD />
            </div>
            <div style={{ position: "absolute", inset: 0, display: rightTab === "docs" ? "block" : "none" }}>
              <DocsViewer sessionId={sessionId} />
            </div>
            <div style={{ position: "absolute", inset: 0, display: rightTab === "deliverable" ? "block" : "none" }}>
              <DeliverablePanel sessionId={sessionId} />
            </div>
          </div>
        </div>
      </div>

      {/* Session-ended overlay — covers the whole workspace. Acknowledgement
          only; analysis runs server-side and there's no candidate-facing
          scorecard view to link to. */}
      {status === "ended" && <EndScreen />}
    </div>
  );
}

function ScenarioChrome() {
  const { scenario } = useSessionStore();
  const difficulty = scenario.difficulty;
  const pillColor = difficulty === "mid" ? "#dcb67a" : "#858585";
  return (
    <div
      style={{
        height: 32,
        flexShrink: 0,
        background: "#2d2d2d",
        borderBottom: "1px solid #404040",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 16px",
      }}
    >
      <div
        style={{
          fontSize: 13,
          color: "#ffffff",
          fontWeight: 500,
          letterSpacing: "-0.1px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {scenario.title ?? "Untitled scenario"}
      </div>
      {(scenario.role || scenario.difficulty) && (
        <span
          style={{
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: pillColor,
            border: `1px solid ${pillColor}`,
            borderRadius: 999,
            padding: "2px 8px",
            fontWeight: 600,
            whiteSpace: "nowrap",
            flexShrink: 0,
            marginLeft: 12,
          }}
        >
          {[scenario.role, scenario.difficulty].filter(Boolean).join(" · ")}
        </span>
      )}
    </div>
  );
}
