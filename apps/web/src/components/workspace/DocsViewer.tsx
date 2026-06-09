"use client";
import { useEffect, useState } from "react";
import { listScenarioDocs, recordDocView, type ScenarioDoc } from "@/lib/api";
import MarkdownView from "./MarkdownView";
import { color } from "@/styles/tokens";
import TabStrip, { type TabSpec } from "@/components/ui/TabStrip";
import SectionLabel from "@/components/ui/SectionLabel";

interface Props { sessionId: string; }

/** Top tab strip (one per doc) + body. Replaces the prior 180px nested
 *  sidebar — the right pane is now narrower-by-default after the
 *  resizable-panels rework, so a horizontal tab strip uses the width far
 *  more efficiently than a fixed sub-sidebar. */
export default function DocsViewer({ sessionId }: Props) {
  const [docs, setDocs] = useState<ScenarioDoc[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listScenarioDocs(sessionId)
      .then((d) => {
        if (cancelled) return;
        setDocs(d);
        if (d.length > 0) {
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

  // Truncate long titles so the tab strip stays one row.
  const tabs: TabSpec<string>[] = docs.map((d) => ({
    id: d.id,
    label: d.title.length > 28 ? d.title.slice(0, 26) + "…" : d.title,
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: color.bg.page, overflow: "hidden" }}>
      <div style={{
        padding: "8px 14px",
        background: color.bg.elevated,
        borderBottom: `1px solid ${color.border.subtle}`,
        flexShrink: 0,
      }}>
        <SectionLabel>Reference Docs</SectionLabel>
      </div>

      {docs.length > 0 && selectedId && (
        <TabStrip
          tabs={tabs}
          value={selectedId}
          onChange={selectDoc}
          variant="pill"
          style={{
            background: color.bg.panel,
            borderBottom: `1px solid ${color.border.subtle}`,
            padding: "6px 10px",
          }}
        />
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px" }}>
        {loading && (
          <div style={{ color: color.text.muted, fontSize: 12, textAlign: "center", padding: "32px 12px" }}>
            Loading…
          </div>
        )}
        {error && (
          <div style={{ color: color.error.base, fontSize: 12, padding: "12px 16px", background: color.error.soft, borderRadius: 6 }}>
            {error}
          </div>
        )}
        {!loading && !error && docs.length === 0 && (
          <div style={{ color: color.text.muted, fontSize: 12, textAlign: "center", padding: "32px 12px" }}>
            No docs for this scenario.
          </div>
        )}
        {selected && <MarkdownView source={selected.body} />}
      </div>
    </div>
  );
}
