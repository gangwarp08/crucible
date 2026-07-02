"use client";
import { useRef, useCallback } from "react";
import MonacoEditor from "@monaco-editor/react";
import { writeFile } from "@/lib/api";
import { useSessionStore, isWorkspaceWritable } from "@/stores/sessionStore";

interface Props {
  sessionId: string;
  path: string | null;
  content: string;
  onChange: (content: string) => void;
}

const LANG_MAP: Record<string, string> = {
  ts: "typescript", tsx: "typescript",
  js: "javascript", jsx: "javascript",
  py: "python", rs: "rust", go: "go",
  json: "json", md: "markdown", css: "css",
  html: "html", sh: "shell", bash: "shell",
  yaml: "yaml", yml: "yaml", toml: "toml",
  txt: "plaintext",
};

function langForPath(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return LANG_MAP[ext] ?? "plaintext";
}

export default function Editor({ sessionId, path, content, onChange }: Props) {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // RD1: once the work is locked (submitted/defending/ended) the editor is
  // read-only; writes would 409 server-side anyway.
  const writable = useSessionStore((s) => isWorkspaceWritable(s.status));

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value === undefined) return;
      onChange(value);
      if (!path || !writable) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        writeFile(sessionId, path, value).catch(console.error);
      }, 500);
    },
    [sessionId, path, onChange, writable],
  );

  if (!path) {
    return (
      <div
        style={{
          flex: 1,
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#8A9389",
          fontSize: 14,
          background: "#FBF7EF",
        }}
      >
        Select a file to edit
      </div>
    );
  }

  return (
    <MonacoEditor
      height="100%"
      language={langForPath(path)}
      value={content}
      theme="vs"
      onChange={handleChange}
      options={{
        readOnly: !writable,
        minimap: { enabled: false },
        fontSize: 14,
        lineHeight: 22,
        scrollBeyondLastLine: false,
        renderLineHighlight: "gutter",
        padding: { top: 12 },
        automaticLayout: true,
      }}
    />
  );
}
