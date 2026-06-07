"use client";
import { useRef, useCallback } from "react";
import MonacoEditor from "@monaco-editor/react";
import { writeFile } from "@/lib/api";

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

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value === undefined) return;
      onChange(value);
      if (!path) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        writeFile(sessionId, path, value).catch(console.error);
      }, 500);
    },
    [sessionId, path, onChange],
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
          color: "#858585",
          fontSize: 14,
          background: "#1e1e1e",
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
      theme="vs-dark"
      onChange={handleChange}
      options={{
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
