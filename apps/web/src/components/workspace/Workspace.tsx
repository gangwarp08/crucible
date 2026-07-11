"use client";
import { useState, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  FileText, BookOpen, MessageSquare, Database, TerminalSquare, Sparkles, Send,
  HelpCircle,
} from "lucide-react";
import FileTree from "./FileTree";
import ConstraintHUD from "./ConstraintHUD";
import BriefPanel from "./BriefPanel";
import EndScreen from "./EndScreen";
import OrientationOverlay from "./OrientationOverlay";
import { readFile, getSession, getAssistantHistory, startSession } from "@/lib/api";
import { useIntegrityMonitor } from "@/lib/integrity";
import { useWebcamPresence } from "@/lib/webcam-presence";
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
      return parsed;
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
  // Help-mode orientation overlay (reopened via the Help button while the clock
  // is already running). Distinct from the PRE-START overlay, which is derived
  // from clockStarted below — never from this flag.
  const [helpOpen, setHelpOpen] = useState(false);

  const status = useSessionStore((s) => s.status);
  const scenario = useSessionStore((s) => s.scenario);
  const clockStarted = useSessionStore((s) => s.clockStarted);
  const init = useSessionStore((s) => s.init);
  const startClock = useSessionStore((s) => s.startClock);
  const setStatus = useSessionStore((s) => s.setStatus);
  const setMessages = useSessionStore((s) => s.setMessages);
  // The store's sessionId, distinct from the prop. Used to suppress UI from
  // a PRIOR session (EndScreen overlay especially) while the new session is
  // still hydrating. `hydrated` flips true once the store matches the route.
  const storeSessionId = useSessionStore((s) => s.sessionId);
  const hydrated = storeSessionId === sessionId;

  // Passive integrity signals (Proctoring v1) — informational only, never
  // scored. Armed only while the candidate is actually working (active, or
  // token_exhausted where work continues without the assistant).
  useIntegrityMonitor(sessionId, hydrated && (status === "active" || status === "token_exhausted"));

  // P6.3 (proctoring v2, DORMANT) — webcam presence sampling. Same arming
  // window as the passive monitor, but the hook ALSO gates internally on the
  // session's recorded-consent marker BEFORE touching getUserMedia: for every
  // session that never accepted the v2 consent (i.e. all of them while the
  // org flag is off), this line is a no-op — no permission prompt, ever.
  useWebcamPresence(sessionId, hydrated && (status === "active" || status === "token_exhausted"));

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
    // clockStarted=true on the eager placeholder so the PRE-START overlay never
    // flashes during the boot window before getSession resolves — the real
    // value (false for a fresh session) arrives from the server hydrate below.
    init(sessionId, "", 0, 0, null, null, null,
      { title: null, brief: null, role: null, difficulty: null,
        clientPersona: null, teamPersona: null }, true);
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
            clientPersona: s.clientPersona ?? null,
            teamPersona:   s.teamPersona ?? null,
          },
          // Older servers omit clockStarted → undefined; treat as already
          // started (no pre-start overlay) so a stale server can't strand the
          // candidate behind an overlay whose Start call has no route.
          s.clockStarted !== false,
        );
        if (s.status === "completed") setStatus("ended");
        else if (s.status === "submitted" || s.status === "defending") setStatus("locked");
        else if (s.scenarioTokensRemaining !== null && s.scenarioTokensRemaining <= 0) {
          setStatus("token_exhausted");
        }

        // Hydrate the AI assistant pane (ChatHUD reads sessionStore.messages)
        // from the transcript table. Chained AFTER `init` so the init's
        // messages=[] reset can't clobber the hydrated array. Failure mode
        // tolerable: pane just renders empty, candidate can re-ask.
        //
        // Race guards:
        //  1. sessionId still matches — drop if the user navigated mid-fetch.
        //  2. messages still empty — if the candidate started chatting before
        //     hydration returned, their optimistic addMessage wins; we don't
        //     clobber a live turn with stale history.
        getAssistantHistory(sessionId)
          .then((items) => {
            if (items.length === 0) return;
            const state = useSessionStore.getState();
            if (state.sessionId !== sessionId) return;
            if (state.messages.length > 0) return;
            setMessages(items);
          })
          .catch(() => { /* tolerate */ });
      })
      .catch(() => { /* server may be starting — workspace still usable */ });
  }, [sessionId, init, setStatus, setMessages]);

  // Warn the candidate before refresh / tab close while the session is live.
  // The browser's native "Reload site?" dialog is the only available UX —
  // custom messages are ignored. Skipped once status leaves "active" so Submit
  // → EndScreen → refresh doesn't prompt. `hydrated` guards against a brief
  // window where storeSessionId still belongs to a prior session.
  useEffect(() => {
    if (!hydrated || status !== "active") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hydrated, status]);

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

  // A terminal WebSocket close is NOT a reliable session-end signal — it also
  // fires on a transient server restart/deploy or a network blip, which was
  // spuriously showing the "session complete" screen mid-session. Confirm with
  // the server before ending: only a genuinely completed session flips to
  // EndScreen; submitted/defending → locked; still-active or an unreachable
  // server (blip) is ignored so the candidate keeps working.
  const handleSessionEnd = useCallback(() => {
    if (status !== "active") return;
    getSession(sessionId)
      .then((s) => {
        if (s.status === "completed") setStatus("ended");
        else if (s.status === "submitted" || s.status === "defending") setStatus("locked");
      })
      .catch(() => { /* transient — do not end the session on a blip */ });
  }, [status, sessionId, setStatus]);

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
            {scenario.title ?? "Asaya session"}
          </div>
          {scenario.difficulty && (
            <Pill tone={scenario.difficulty === "mid" ? "warn" : "neutral"}>
              {[scenario.role, scenario.difficulty].filter(Boolean).join(" · ")}
            </Pill>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }} />
        <button
          type="button"
          data-tour="help"
          onClick={() => setHelpOpen(true)}
          aria-label="Workspace orientation"
          title="Workspace orientation"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            height: 28,
            padding: "0 10px",
            background: "transparent",
            border: `1px solid ${color.border.default}`,
            borderRadius: 3,
            color: color.text.secondary,
            cursor: "pointer",
            gap: 6,
            marginRight: 12,
          }}
        >
          <HelpCircle size={14} />
          <span style={{
            fontFamily: "var(--font-mono, monospace)",
            fontSize: 11,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}>
            Orientation
          </span>
        </button>
        <span data-tour="constraints" style={{ display: "inline-flex", alignItems: "center" }}>
          <ConstraintHUD />
        </span>
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
                data-tour="files"
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
              <div data-integrity-panel="editor" data-tour="editor" style={{ height: "100%", display: "flex", overflow: "hidden" }}>
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
                <div data-tour="tabs">
                  <TabStrip
                    tabs={TABS}
                    value={rightTab}
                    onChange={setRightTab}
                    variant="underline"
                  />
                </div>
                <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
                  <div data-integrity-panel="brief" style={{ position: "absolute", inset: 0, display: rightTab === "brief" ? "block" : "none" }}>
                    <BriefPanel />
                  </div>
                  <div data-integrity-panel="docs" style={{ position: "absolute", inset: 0, display: rightTab === "docs" ? "block" : "none" }}>
                    <DocsViewer sessionId={sessionId} />
                  </div>
                  <div data-integrity-panel="message" style={{ position: "absolute", inset: 0, display: rightTab === "messages" ? "block" : "none" }}>
                    <Messages sessionId={sessionId} />
                  </div>
                  <div style={{ position: "absolute", inset: 0, display: rightTab === "data" ? "block" : "none" }}>
                    <DataExplorer sessionId={sessionId} />
                  </div>
                  <div style={{ position: "absolute", inset: 0, display: rightTab === "terminal" ? "block" : "none" }}>
                    <Terminal sessionId={sessionId} onSessionEnd={handleSessionEnd} />
                  </div>
                  <div data-integrity-panel="chat" style={{ position: "absolute", inset: 0, display: rightTab === "assistant" ? "block" : "none" }}>
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

      {/* Orientation overlay — the watermark tutorial map.
          Two modes over the SAME component:

          PRE-START (showStart): shown automatically at the start of EVERY
          simulation while the clock has not been started, gated on `hydrated`
          so it reflects THIS session's real clockStarted (not a boot-window
          flash or a prior session's residual) and suppressed once ended.
          Dismissing it — the "Start the simulation" button — is the ONLY way
          the clock starts: startSession() re-anchors the deadline server-side,
          startClock() flips clockStarted=true (which unmounts this overlay).
          A mid-session refresh cannot reshow it: the server reports
          clockStarted=true after /start, so this branch is false on reload.

          HELP (helpOpen): reopened via the Help button while the clock is
          already running. Same visuals, but the button reads "Close" and only
          dismisses — the clock is untouched. Pre-start takes precedence so the
          two can never stack. */}
      {hydrated && status !== "ended" && !clockStarted && (
        <OrientationOverlay
          showStart
          onStart={async () => {
            const resp = await startSession(sessionId);
            startClock(resp.deadline);
          }}
          onDismiss={() => { /* pre-start: dismissal only happens via onStart */ }}
        />
      )}
      {hydrated && status !== "ended" && clockStarted && helpOpen && (
        <OrientationOverlay
          showStart={false}
          onStart={() => { /* unused in help mode */ }}
          onDismiss={() => setHelpOpen(false)}
        />
      )}
    </div>
  );
}
