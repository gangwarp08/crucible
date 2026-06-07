"use client";
import { useEffect, useState, useCallback } from "react";
import { listFiles, type FileEntry } from "@/lib/api";

interface Props {
  sessionId: string;
  onFileSelect: (path: string) => void;
  selectedPath: string | null;
}

interface NodeProps {
  entry: FileEntry;
  sessionId: string;
  depth: number;
  onFileSelect: (path: string) => void;
  selectedPath: string | null;
}

function TreeNode({ entry, sessionId, depth, onFileSelect, selectedPath }: NodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);
  const isSelected = !entry.isDir && entry.path === selectedPath;

  const handleClick = useCallback(async () => {
    if (!entry.isDir) {
      onFileSelect(entry.path);
      return;
    }
    if (!expanded) {
      const entries = await listFiles(sessionId, entry.path);
      setChildren(
        [...entries].sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        }),
      );
    }
    setExpanded((e) => !e);
  }, [entry, expanded, sessionId, onFileSelect]);

  return (
    <div>
      <div
        onClick={() => { void handleClick(); }}
        style={{
          paddingLeft: 8 + depth * 16,
          paddingTop: 3,
          paddingBottom: 3,
          paddingRight: 8,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 5,
          fontSize: 13,
          color: isSelected ? "#fff" : "#cccccc",
          background: isSelected ? "#094771" : "transparent",
          userSelect: "none",
          transition: "background 0.08s",
        }}
        onMouseEnter={(e) => {
          if (!isSelected)
            (e.currentTarget as HTMLDivElement).style.background = "#2a2d2e";
        }}
        onMouseLeave={(e) => {
          if (!isSelected)
            (e.currentTarget as HTMLDivElement).style.background = "transparent";
        }}
      >
        <span
          style={{
            fontSize: 10,
            color: entry.isDir ? "#dcb67a" : "#858585",
            flexShrink: 0,
            width: 10,
            textAlign: "center",
          }}
        >
          {entry.isDir ? (expanded ? "▾" : "▸") : "·"}
        </span>
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {entry.name}
        </span>
      </div>
      {expanded &&
        children.map((child) => (
          <TreeNode
            key={child.path}
            entry={child}
            sessionId={sessionId}
            depth={depth + 1}
            onFileSelect={onFileSelect}
            selectedPath={selectedPath}
          />
        ))}
    </div>
  );
}

export default function FileTree({ sessionId, onFileSelect, selectedPath }: Props) {
  const [roots, setRoots] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void listFiles(sessionId, "/workspace").then((entries) => {
      setRoots(
        [...entries].sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        }),
      );
      setLoading(false);
    });
  }, [sessionId]);

  return (
    <div style={{ paddingTop: 4 }}>
      <div
        style={{
          padding: "8px 12px 6px",
          fontSize: 11,
          fontWeight: 600,
          color: "#858585",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          userSelect: "none",
        }}
      >
        Explorer
      </div>
      {loading ? (
        <div style={{ padding: "8px 16px", color: "#858585", fontSize: 13 }}>
          Loading…
        </div>
      ) : roots.length === 0 ? (
        <div style={{ padding: "8px 16px", color: "#858585", fontSize: 13 }}>
          Empty workspace
        </div>
      ) : (
        roots.map((entry) => (
          <TreeNode
            key={entry.path}
            entry={entry}
            sessionId={sessionId}
            depth={0}
            onFileSelect={onFileSelect}
            selectedPath={selectedPath}
          />
        ))
      )}
    </div>
  );
}
