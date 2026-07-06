"use client";
import { useRef, useCallback } from "react";
import MonacoEditor from "@monaco-editor/react";
import { writeFile } from "@/lib/api";
import { useSessionStore, isWorkspaceWritable } from "@/stores/sessionStore";
import { color } from "@/styles/tokens";

// Structural type for the slice of the Monaco API we touch. The full type
// lives in the `monaco-editor` package, which isn't a direct dependency —
// @monaco-editor/react loads it from CDN at runtime.
interface MonacoThemeApi {
  editor: {
    defineTheme: (
      name: string,
      theme: { base: string; inherit: boolean; rules: unknown[]; colors: Record<string, string> },
    ) => void;
  };
}

// Monaco theme colors must be hex (#RRGGBB[AA]) — rgba() strings are not
// accepted, so the lime tints below are alpha-hex equivalents of the
// accent tokens (#a3e635 at low opacity).
function defineAsayaTheme(monaco: MonacoThemeApi): void {
  monaco.editor.defineTheme("asaya-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": color.bg.input,
      "editor.lineHighlightBackground": color.bg.panel,
      "editor.selectionBackground": "#a3e63533",         // color.accent.base @ 20%
      "editor.inactiveSelectionBackground": "#a3e6351a", // color.accent.base @ 10%
    },
  });
}

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
          color: color.text.muted,
          fontSize: 14,
          background: color.bg.input,
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
      theme="asaya-dark"
      beforeMount={defineAsayaTheme}
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
