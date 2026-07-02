"use client";
import { useState, useRef } from "react";
import { runQuery, type QueryResult } from "@/lib/api";
import { color, font, radius } from "@/styles/tokens";
import Button from "@/components/ui/Button";
import { useSessionStore, isWorkspaceWritable } from "@/stores/sessionStore";

interface Props { sessionId: string; }

const STARTER_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;";

export default function DataExplorer({ sessionId }: Props) {
  const [sql, setSql] = useState(STARTER_SQL);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [transportError, setTransportError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // RD1: queries blocked once the work is locked (server 409s anyway).
  const writable = useSessionStore((s) => isWorkspaceWritable(s.status));

  const canRun = !running && writable && sql.trim().length > 0;

  async function handleRun() {
    if (!canRun) return;
    setRunning(true);
    setTransportError(null);
    try {
      const res = await runQuery(sessionId, sql.trim());
      setResult(res);
    } catch (err) {
      setTransportError(err instanceof Error ? err.message : "Network error — please retry.");
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void handleRun();
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: color.bg.page, overflow: "hidden" }}>
      <div style={{
        padding: "10px 12px",
        background: color.bg.panel,
        borderBottom: `1px solid ${color.border.subtle}`,
        display: "flex", flexDirection: "column", gap: 8,
        flexShrink: 0,
      }}>
        <textarea
          ref={textareaRef}
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          placeholder="-- Read-only SQLite at /workspace/customer.db. ⌘/Ctrl+Enter to run."
          style={{
            width: "100%",
            minHeight: 96,
            maxHeight: 200,
            background: color.bg.input,
            border: `1px solid ${color.border.default}`,
            borderRadius: radius.sm,
            color: color.text.primary,
            fontSize: 12,
            fontFamily: font.mono,
            padding: "10px 12px",
            outline: "none",
            resize: "vertical",
            lineHeight: 1.45,
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Button variant="primary" size="md" disabled={!canRun} onClick={() => { void handleRun(); }}>
            {running ? "Running…" : "Run query"}
          </Button>
          <div style={{ fontSize: 11, color: color.text.muted, flex: 1, fontFamily: font.mono, fontVariantNumeric: "tabular-nums" }}>
            {result?.status === "ok" && (
              <>
                {result.rowCount} row{result.rowCount === 1 ? "" : "s"} · {result.durationMs}ms
                {result.truncated && (
                  <span style={{ color: color.warn.base, marginLeft: 10 }}>
                    showing first 500 — add a LIMIT or aggregate
                  </span>
                )}
              </>
            )}
            {result?.status === "error" && (
              <span>error in {result.durationMs}ms</span>
            )}
          </div>
        </div>
      </div>

      {transportError && (
        <Banner>{transportError}</Banner>
      )}
      {result?.status === "error" && (
        <Banner mono>{result.error}</Banner>
      )}

      <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
        {result?.status === "ok" ? (
          result.rows.length === 0 ? (
            <Empty>Query returned 0 rows.</Empty>
          ) : (
            <div style={{
              background: color.bg.panel,
              border: `1px solid ${color.border.subtle}`,
              borderRadius: radius.md,
              overflow: "hidden",
            }}>
              <table style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
                fontFamily: font.mono,
                fontVariantNumeric: "tabular-nums",
              }}>
                <thead>
                  <tr style={{ background: color.bg.elevated }}>
                    {result.columns.map((col) => (
                      <th
                        key={col}
                        style={{
                          padding: "10px 14px",
                          textAlign: "left",
                          fontSize: 10,
                          color: color.text.muted,
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                          fontWeight: 600,
                          borderBottom: `1px solid ${color.border.subtle}`,
                          whiteSpace: "nowrap",
                          fontFamily: font.sans,
                        }}
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, ri) => (
                    <tr
                      key={ri}
                      style={{
                        borderBottom: ri < result.rows.length - 1 ? `1px solid ${color.border.subtle}` : "none",
                        background: ri % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)",
                      }}
                    >
                      {result.columns.map((_, ci) => (
                        <td
                          key={ci}
                          style={{
                            padding: "8px 14px",
                            color: color.text.primary,
                            whiteSpace: "nowrap",
                            verticalAlign: "top",
                          }}
                        >
                          {renderCell(row[ci])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : !result && !transportError ? (
          <Empty>
            Run a query to explore the read-only customer database.
            <div style={{ marginTop: 4, fontSize: 11 }}>
              Hint: <code style={{ fontFamily: font.mono }}>sqlite_master</code> lists tables.
            </div>
          </Empty>
        ) : null}
      </div>
    </div>
  );
}

function Banner({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{
      padding: "10px 14px",
      background: color.error.soft,
      color: color.error.base,
      fontSize: 12,
      fontFamily: mono ? font.mono : font.sans,
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      flexShrink: 0,
      borderBottom: `1px solid ${color.border.subtle}`,
    }}>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ color: color.text.muted, fontSize: 12, textAlign: "center", padding: "40px 16px", lineHeight: 1.6 }}>
      {children}
    </div>
  );
}

function renderCell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}
