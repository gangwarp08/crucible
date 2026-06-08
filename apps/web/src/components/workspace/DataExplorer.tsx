"use client";
import { useState, useRef } from "react";
import { runQuery, type QueryResult } from "@/lib/api";

interface Props {
  sessionId: string;
}

const STARTER_SQL =
  "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;";

export default function DataExplorer({ sessionId }: Props) {
  const [sql, setSql] = useState(STARTER_SQL);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [transportError, setTransportError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canRun = !running && sql.trim().length > 0;

  async function handleRun() {
    if (!canRun) return;
    setRunning(true);
    setTransportError(null);
    try {
      const res = await runQuery(sessionId, sql.trim());
      setResult(res);
    } catch (err) {
      setTransportError(
        err instanceof Error ? err.message : "Network error — please retry.",
      );
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl + Enter to run.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void handleRun();
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#1e1e1e",
        overflow: "hidden",
      }}
    >
      {/* SQL editor */}
      <div
        style={{
          padding: "8px 10px",
          background: "#252526",
          borderBottom: "1px solid #404040",
          display: "flex",
          flexDirection: "column",
          gap: 6,
          flexShrink: 0,
        }}
      >
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
            background: "#3c3c3c",
            border: "1px solid #555",
            borderRadius: 4,
            color: "#cccccc",
            fontSize: 12,
            fontFamily: "'SF Mono', Menlo, Consolas, 'Courier New', monospace",
            padding: "8px 10px",
            outline: "none",
            resize: "vertical",
            lineHeight: 1.4,
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={() => { void handleRun(); }}
            disabled={!canRun}
            style={{
              background: canRun ? "#0e639c" : "#37373d",
              color: canRun ? "#fff" : "#555",
              border: "none",
              borderRadius: 4,
              padding: "5px 14px",
              fontSize: 13,
              cursor: canRun ? "pointer" : "not-allowed",
            }}
          >
            {running ? "Running…" : "Run"}
          </button>
          <div style={{ fontSize: 11, color: "#858585", flex: 1 }}>
            {result?.status === "ok" && (
              <>
                {result.rowCount} row{result.rowCount === 1 ? "" : "s"} in {result.durationMs} ms
                {result.truncated && (
                  <span style={{ color: "#dcdcaa", marginLeft: 8 }}>
                    (showing first 500 — add a LIMIT or aggregate)
                  </span>
                )}
              </>
            )}
            {result?.status === "error" && (
              <span style={{ color: "#858585" }}>
                error in {result.durationMs} ms
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Transport error banner */}
      {transportError && (
        <div
          style={{
            padding: "8px 12px",
            background: "#4b2020",
            color: "#f48771",
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          {transportError}
        </div>
      )}

      {/* SQL error banner */}
      {result?.status === "error" && (
        <div
          style={{
            padding: "10px 12px",
            background: "#4b2020",
            color: "#f48771",
            fontSize: 12,
            fontFamily: "'SF Mono', Menlo, Consolas, monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            flexShrink: 0,
            borderBottom: "1px solid #404040",
          }}
        >
          {result.error}
        </div>
      )}

      {/* Results table */}
      <div style={{ flex: 1, overflow: "auto", padding: 10 }}>
        {result?.status === "ok" ? (
          result.rows.length === 0 ? (
            <div
              style={{
                color: "#555",
                fontSize: 12,
                textAlign: "center",
                padding: "32px 12px",
              }}
            >
              Query returned 0 rows.
            </div>
          ) : (
            <div
              style={{
                background: "#252526",
                border: "1px solid #404040",
                borderRadius: 6,
                overflow: "hidden",
              }}
            >
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 12,
                  fontFamily: "'SF Mono', Menlo, Consolas, monospace",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <thead>
                  <tr style={{ background: "#2d2d2d" }}>
                    {result.columns.map((col) => (
                      <th
                        key={col}
                        style={{
                          padding: "8px 12px",
                          textAlign: "left",
                          fontSize: 11,
                          color: "#858585",
                          textTransform: "uppercase",
                          letterSpacing: "0.04em",
                          fontWeight: 600,
                          borderBottom: "1px solid #404040",
                          whiteSpace: "nowrap",
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
                        borderBottom: ri < result.rows.length - 1 ? "1px solid #2d2d2d" : "none",
                      }}
                    >
                      {result.columns.map((_, ci) => (
                        <td
                          key={ci}
                          style={{
                            padding: "6px 12px",
                            color: "#cccccc",
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
          <div
            style={{
              color: "#555",
              fontSize: 12,
              textAlign: "center",
              padding: "32px 12px",
              lineHeight: 1.6,
            }}
          >
            Run a query to explore the read-only customer database.
            <br />
            <span style={{ fontSize: 11 }}>
              Hint: <code>sqlite_master</code> lists tables.
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function renderCell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}
