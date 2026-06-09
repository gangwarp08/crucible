"use client";
import { useEffect, useState } from "react";
import { listScenarioDocs, recordDocView, type ScenarioDoc } from "@/lib/api";
import MarkdownView from "./MarkdownView";

interface Props {
  sessionId: string;
}

export default function DocsViewer({ sessionId }: Props) {
  const [docs, setDocs] = useState<ScenarioDoc[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load doc list once per sessionId mount.
  useEffect(() => {
    let cancelled = false;
    listScenarioDocs(sessionId)
      .then((d) => {
        if (cancelled) return;
        setDocs(d);
        if (d.length > 0) {
          // Auto-select + fire view event for the first doc so recruiter
          // timeline always shows "candidate opened Docs" at minimum.
          setSelectedId(d[0]!.id);
          void recordDocView(sessionId, d[0]!.id);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [sessionId]);

  function selectDoc(id: string) {
    if (selectedId === id) return;
    setSelectedId(id);
    void recordDocView(sessionId, id);
  }

  const selected = docs.find((d) => d.id === selectedId);

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        background: "#1e1e1e",
        overflow: "hidden",
      }}
    >
      {/* Doc list */}
      <div
        style={{
          width: 180,
          minWidth: 180,
          background: "#252526",
          borderRight: "1px solid #404040",
          overflowY: "auto",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            padding: "5px 12px",
            fontSize: 11,
            color: "#858585",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            borderBottom: "1px solid #404040",
            userSelect: "none",
          }}
        >
          Reference Docs
        </div>
        {loading && (
          <div style={{ padding: "10px 12px", fontSize: 12, color: "#555" }}>
            Loading…
          </div>
        )}
        {error && (
          <div style={{ padding: "10px 12px", fontSize: 12, color: "#f48771" }}>
            {error}
          </div>
        )}
        {!loading && !error && docs.length === 0 && (
          <div style={{ padding: "10px 12px", fontSize: 12, color: "#555" }}>
            No docs for this scenario.
          </div>
        )}
        {docs.map((d) => {
          const active = d.id === selectedId;
          return (
            <button
              key={d.id}
              onClick={() => selectDoc(d.id)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "8px 12px",
                background: active ? "#094771" : "transparent",
                color: active ? "#ffffff" : "#cccccc",
                border: "none",
                borderBottom: "1px solid #2d2d2d",
                fontSize: 12,
                fontFamily: "inherit",
                cursor: "pointer",
              }}
            >
              {d.title}
            </button>
          );
        })}
      </div>

      {/* Doc body */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px 20px",
        }}
      >
        {selected ? (
          <MarkdownView source={selected.body} />
        ) : !loading && !error ? (
          <div style={{ color: "#555", fontSize: 12, textAlign: "center", paddingTop: 32 }}>
            Select a document.
          </div>
        ) : null}
      </div>
    </div>
  );
}
