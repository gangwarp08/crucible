"use client";
import { useState, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  FileText, BookOpen, MessageSquare, Database, TerminalSquare, Sparkles, Send,
} from "lucide-react";
import FileTree from "./FileTree";
import ConstraintHUD from "./ConstraintHUD";
import BriefPanel from "./BriefPanel";
import EndScreen from "./EndScreen";
import { readFile, getSession } from "@/lib/api";
import { useSessionStore } from "@/stores/sessionStore";
import { color } from "@/styles/tokens";
import TabStrip, { type TabSpec } from "@/components/ui/TabStrip";
import Pill from "@/components/ui/Pill";

const Editor = dynamic(() => import("./Editor"), { ssr: false });
const Terminal = dynamic(() => import("./Terminal"), { ssr: false });
const ChatHUD = dynamic(() => import("./ChatHUD"), { ssr: false });
const DataExplorer = dynamic(() => import("./DataExplorer"), { ssr: false });
const Messages = dynamic(() => import("./Messages"), { ssr: false });
const DocsViewer = dynamic(() => import("./DocsViewer"), { ssr: false });
const DeliverablePanel = dynamic(() => import("./DeliverablePanel"), { ssr: false });

type RightTab = "brief" | "docs" | "messages" | "data" | "terminal" | "assistant" | "deliverable";

// Reordered by candidate workflow: orient → communicate → execute → submit.
// Icons via lucide; consistently sized at 14px so the underline strip stays
// vertically tight.
const TABS: ReadonlyArray<TabSpec<RightTab>> = [
  { id: "brief",       label: "Brief",       icon: <FileText size={14} /> },
  { id: "docs",        label: "Docs",        icon: <BookOpen size={14} /> },
  { id: "messages",    label: "Messages",    icon: <MessageSquare size={14} /> },
  { id: "data",        label: "Data",        icon: <Database size={14} /> },
  { id: "terminal",    label: "Terminal",    icon: <TerminalSquare size={14} /> },
  { id: "assistant",   label: "Assistant",   icon: <Sparkles size={14} /> },
  { id: "deliverable", label: "Deliverable", icon: <Send size={14} /> },
];

// localStorage key for panel sizes — versioned so a future layout-shape change
// doesn't restore a stale layout.
const LAYOUT_KEY = "crucible.workspace.layout.v1";
const DEFAULT_SIZES = [18, 50, 32]; // file tree / editor / tools

function loadLayout(): number[] {
  if (typeof window === "undefined") return DEFAULT_SIZES;
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    if (!raw) return DEFAULT_SIZES;
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.length === 3 && parsed.every((n) => typeof n === "number")) {
      return parsed as number[];
    }
  } catch { /* fall through */ }
  return DEFAULT_SIZES;
}

interface Props {
  sessionId: string;
}

export default function Workspace({ sessionId }: Props) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [rightTab, setRightTab] = useState<RightTab>("brief");
  const [layout, setLayout] = useState<number[]>(DEFAULT_SIZES);
  const [layoutReady, setLayoutReady] = useState(false);

  const { init, setStatus, status, scenario } = useSessionStore();
  // The store's sessionId, distinct from the prop. Used to suppress UI from
  // a PRIOR session (EndScreen overlay especially) while the new session is
  // still hydrating. `hydrated` flips true once the store matches the route.
  const storeSessionId = useSessionStore((s) => s.sessionId);
  const hydrated = storeSessionId === sessionId;

  // Hydrate panel layout once on mount so the PanelGroup mounts with the
  // persisted sizes, not the defaults.
  useEffect(() => {
    setLayout(loadLayout());
    setLayoutReady(true);
  }, []);

  // On mount: eagerly reset the store with empty defaults for the NEW
  // session BEFORE hydrating from the server. Without this, the zustand
  // store (a module-level singleton) leaks status="ended" / endedAt /
  // sessionId from a prior session across the route change — which
  // renders EndScreen the moment the new workspace mounts. After the
  // eager reset, the brief render before getSession resolves shows a
  // blank workspace (loading), not the prior session's EndScreen.
  useEffect(() => {
    init(sessionId, "", 0, 0, null, null, null,
      { title: null, brief: null, role: null, difficulty: null });
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

  const persistLayout = useCallback((sizes: number[]) => {
    setLayout(sizes);
    if (typeof window !== "undefined") {
      try { window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(sizes)); } catch { /* ignore */ }
    }
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
        background: color.bg.page,
        color: color.text.primary,
      }}
    >
      {/* Merged top chrome: scenario title + pill on the left, live HUD on the right.
          Single 44px row replacing the prior two stacked 32px rows. */}
      <header
        style={{
          height: 44,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "0 16px",
          background: color.bg.panel,
          borderBottom: `1px solid ${color.border.subtle}`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            minWidth: 0,
            flex: "0 1 auto",
          }}
        >
          <div
            style={{
              fontSize: 13,
              color: color.text.primary,
              fontWeight: 600,
              letterSpacing: "-0.1px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {scenario.title ?? "Crucible session"}
          </div>
          {scenario.difficulty && (
            <Pill tone={scenario.difficulty === "mid" ? "warn" : "neutral"}>
              {[scenario.role, scenario.difficulty].filter(Boolean).join(" · ")}
            </Pill>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }} />
        <ConstraintHUD />
      </header>

      {/* Resizable 3-pane workspace. PanelGroup auto-handles widths in
          percentages. Mount-gate with `layoutReady` to avoid a layout flash
          before localStorage hydrates. */}
      <div style={{ flex: 1, minHeight: 0 }}>
        {layoutReady && (
          <PanelGroup
            direction="horizontal"
            onLayout={persistLayout}
            style={{ height: "100%" }}
          >
            <Panel defaultSize={layout[0]} minSize={10}>
              <div
                style={{
                  height: "100%",
                  background: color.bg.panel,
                  borderRight: `1px solid ${color.border.subtle}`,
                  overflowY: "auto",
                }}
              >
                <FileTree
                  sessionId={sessionId}
                  onFileSelect={(path) => { void handleFileSelect(path); }}
                  selectedPath={selectedPath}
                />
              </div>
            </Panel>
            <PanelResizeHandle />
            <Panel defaultSize={layout[1]} minSize={25}>
              <div style={{ height: "100%", display: "flex", overflow: "hidden" }}>
                <Editor
                  sessionId={sessionId}
                  path={selectedPath}
                  content={content}
                  onChange={setContent}
                />
              </div>
            </Panel>
            <PanelResizeHandle />
            <Panel defaultSize={layout[2]} minSize={20}>
              <div
                style={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  background: color.bg.page,
                  overflow: "hidden",
                }}
              >
                <TabStrip
                  tabs={TABS}
                  value={rightTab}
                  onChange={setRightTab}
                  variant="underline"
                />
                <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
                  <div style={{ position: "absolute", inset: 0, display: rightTab === "brief" ? "block" : "none" }}>
                    <BriefPanel />
                  </div>
                  <div style={{ position: "absolute", inset: 0, display: rightTab === "docs" ? "block" : "none" }}>
                    <DocsViewer sessionId={sessionId} />
                  </div>
                  <div style={{ position: "absolute", inset: 0, display: rightTab === "messages" ? "block" : "none" }}>
                    <Messages sessionId={sessionId} />
                  </div>
                  <div style={{ position: "absolute", inset: 0, display: rightTab === "data" ? "block" : "none" }}>
                    <DataExplorer sessionId={sessionId} />
                  </div>
                  <div style={{ position: "absolute", inset: 0, display: rightTab === "terminal" ? "block" : "none" }}>
                    <Terminal sessionId={sessionId} onSessionEnd={handleSessionEnd} />
                  </div>
                  <div style={{ position: "absolute", inset: 0, display: rightTab === "assistant" ? "block" : "none" }}>
                    <ChatHUD />
                  </div>
                  <div style={{ position: "absolute", inset: 0, display: rightTab === "deliverable" ? "block" : "none" }}>
                    <DeliverablePanel sessionId={sessionId} />
                  </div>
                </div>
              </div>
            </Panel>
          </PanelGroup>
        )}
      </div>

      {/* Only render EndScreen when the ended-state belongs to THIS session,
          not a residual from a prior one (the store is a module-level
          singleton). `hydrated` flips true once the store's sessionId
          matches the route prop. */}
      {hydrated && status === "ended" && <EndScreen />}
    </div>
  );
}
