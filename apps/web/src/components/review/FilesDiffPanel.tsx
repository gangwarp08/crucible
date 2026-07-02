"use client";
import { useMemo, useState, useEffect } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { ReviewFileSnapshot } from "@/lib/api";
import { formatDateTime } from "./format";

interface Props {
  fileSnapshots: ReviewFileSnapshot[];
}

const LANG_MAP: Record<string, string> = {
  ts: "typescript", tsx: "typescript",
  js: "javascript", jsx: "javascript",
  py: "python", rs: "rust", go: "go",
  json: "json", md: "markdown", css: "css",
  html: "html", sh: "shell", bash: "shell",
  yaml: "yaml", yml: "yaml", toml: "toml",
};

function langForPath(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return LANG_MAP[ext] ?? "plaintext";
}

export default function FilesDiffPanel({ fileSnapshots }: Props) {
  // Group snapshots by path, preserving ts order (api already orders by ts asc).
  const byPath = useMemo(() => {
    const map = new Map<string, ReviewFileSnapshot[]>();
    for (const snap of fileSnapshots) {
      const arr = map.get(snap.path) ?? [];
      arr.push(snap);
      map.set(snap.path, arr);
    }
    return map;
  }, [fileSnapshots]);

  const paths = Array.from(byPath.keys());
  const [selectedPath, setSelectedPath] = useState<string | null>(paths[0] ?? null);

  // When a new bundle arrives with different paths, pick the first.
  useEffect(() => {
    if (selectedPath && byPath.has(selectedPath)) return;
    setSelectedPath(paths[0] ?? null);
  }, [fileSnapshots, byPath, paths, selectedPath]);

  const snaps = selectedPath ? byPath.get(selectedPath) ?? [] : [];
  const [stepIdx, setStepIdx] = useState(snaps.length - 1);

  useEffect(() => {
    setStepIdx(Math.max(0, snaps.length - 1));
  }, [selectedPath, snaps.length]);

  const safeIdx = Math.min(stepIdx, Math.max(0, snaps.length - 1));
  const current = snaps[safeIdx];
  const previous = safeIdx > 0 ? snaps[safeIdx - 1] : null;
  const language = selectedPath ? langForPath(selectedPath) : "plaintext";

  return (
    <section
      id={selectedPath ? `file-${selectedPath}` : undefined}
      style={{
        background: "#15151b",
        border: "1px solid #2a2a36",
        borderRadius: 6,
        marginBottom: 16,
        overflow: "hidden",
        scrollMarginTop: 16,
      }}
    >
      <header
        style={{
          padding: "10px 16px",
          background: "#1c1c24",
          borderBottom: "1px solid #2a2a36",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: "#9999a3", letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Files / code evolution
        </span>
        <span style={{ fontSize: 11, color: "#6a6a78" }}>
          {paths.length} path{paths.length === 1 ? "" : "s"} · {fileSnapshots.length} snapshot{fileSnapshots.length === 1 ? "" : "s"}
        </span>
      </header>

      {paths.length === 0 ? (
        <div style={{ padding: 24, color: "#6a6a78", fontSize: 13, textAlign: "center" }}>
          No file edits recorded
        </div>
      ) : (
        <>
          <div
            style={{
              padding: "10px 16px",
              background: "#0c0c10",
              borderBottom: "1px solid #22222b",
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
              fontSize: 12,
            }}
          >
            <label style={{ color: "#9999a3" }}>Path</label>
            <select
              value={selectedPath ?? ""}
              onChange={(e) => setSelectedPath(e.target.value)}
              style={{
                background: "#0f0f14",
                color: "#e6e6ea",
                border: "1px solid #555",
                borderRadius: 4,
                padding: "4px 8px",
                fontSize: 12,
                outline: "none",
                fontFamily: "var(--font-mono, ui-monospace, JetBrains Mono, monospace)",
                minWidth: 220,
              }}
            >
              {paths.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>

            <span style={{ flex: 1 }} />

            <label style={{ color: "#9999a3" }}>Step</label>
            <button
              onClick={() => setStepIdx((i) => Math.max(0, i - 1))}
              disabled={safeIdx === 0}
              style={btnStyle(safeIdx === 0)}
            >
              ◂
            </button>
            <span
              style={{
                color: "#e6e6ea",
                fontFamily: "var(--font-mono, ui-monospace, JetBrains Mono, monospace)",
                minWidth: 60,
                textAlign: "center",
                fontSize: 12,
              }}
            >
              {safeIdx + 1} / {snaps.length}
            </span>
            <button
              onClick={() => setStepIdx((i) => Math.min(snaps.length - 1, i + 1))}
              disabled={safeIdx >= snaps.length - 1}
              style={btnStyle(safeIdx >= snaps.length - 1)}
            >
              ▸
            </button>
          </div>

          {current && (
            <>
              <div
                style={{
                  padding: "6px 16px",
                  background: "#15151b",
                  borderBottom: "1px solid #22222b",
                  fontSize: 11,
                  color: "#9999a3",
                  display: "flex",
                  gap: 16,
                  fontFamily: "var(--font-mono, ui-monospace, JetBrains Mono, monospace)",
                }}
              >
                <span>action: <span style={{ color: actionColor(current.action) }}>{current.action}</span></span>
                <span>size: {current.size_bytes ?? "?"} bytes</span>
                <span>hash: {current.content_hash?.slice(0, 12) ?? "—"}…</span>
                <span style={{ marginLeft: "auto" }}>{formatDateTime(current.ts)}</span>
              </div>
              <div style={{ height: 380, background: "#0c0c10" }}>
                <DiffEditor
                  height="100%"
                  language={language}
                  original={previous?.content ?? ""}
                  modified={current.content ?? ""}
                  theme="vs-dark"
                  options={{
                    readOnly: true,
                    renderSideBySide: true,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: 13,
                    automaticLayout: true,
                  }}
                />
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function btnStyle(disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? "#1c1c24" : "#0f0f14",
    color: disabled ? "#6a6a78" : "#e6e6ea",
    border: "1px solid #555",
    borderRadius: 4,
    padding: "3px 10px",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 13,
  };
}

function actionColor(action: string): string {
  if (action === "create") return "#56d6a8";
  if (action === "write")  return "#7c7fff";
  if (action === "delete") return "#ff7a7a";
  return "#e6e6ea";
}
