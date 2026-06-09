"use client";
import { useEffect, useState, useCallback } from "react";
import { listFiles, type FileEntry } from "@/lib/api";
import { color } from "@/styles/tokens";
import SectionLabel from "@/components/ui/SectionLabel";

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
        data-hover
        data-selected={isSelected ? "true" : undefined}
        style={{
          paddingLeft: 8 + depth * 14,
          paddingTop: 4,
          paddingBottom: 4,
          paddingRight: 8,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 13,
          color: isSelected ? color.text.primary : color.text.secondary,
          background: isSelected ? color.accent.soft : "transparent",
          borderLeft: isSelected ? `2px solid ${color.accent.base}` : "2px solid transparent",
          userSelect: "none",
        }}
      >
        <span
          style={{
            fontSize: 10,
            color: entry.isDir ? color.warn.base : color.text.muted,
            flexShrink: 0,
            width: 10,
            textAlign: "center",
          }}
        >
          {entry.isDir ? (expanded ? "▾" : "▸") : "·"}
        </span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
      <div style={{ padding: "10px 14px 8px" }}>
        <SectionLabel>Explorer</SectionLabel>
      </div>
      {loading ? (
        <div style={{ padding: "8px 16px", color: color.text.muted, fontSize: 13 }}>
          Loading…
        </div>
      ) : roots.length === 0 ? (
        <div style={{ padding: "8px 16px", color: color.text.muted, fontSize: 13 }}>
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
