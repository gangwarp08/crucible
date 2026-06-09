"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  getReviewSessionDetail,
  NotFoundError,
  type ReviewSessionDetail,
} from "@/lib/api";
import SessionDetail from "./SessionDetail";

interface Props {
  id: string;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; detail: ReviewSessionDetail }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

export default function SessionDetailLoader({ id }: Props) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  async function load() {
    setState({ kind: "loading" });
    try {
      const detail = await getReviewSessionDetail(id);
      setState({ kind: "ok", detail });
    } catch (e) {
      if (e instanceof NotFoundError) {
        setState({ kind: "not_found" });
      } else {
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : "Failed to load session",
        });
      }
    }
  }

  useEffect(() => { void load(); }, [id]);

  if (state.kind === "loading") {
    return <Loading />;
  }
  if (state.kind === "not_found") {
    return <NotFound id={id} />;
  }
  if (state.kind === "error") {
    return <Errored message={state.message} onRetry={() => void load()} />;
  }
  return <SessionDetail detail={state.detail} onRefetch={load} />;
}

// ── states ────────────────────────────────────────────────────────────────────

function StatusShell({ children }: { children: React.ReactNode }) {
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#1e1e1e",
        color: "#cccccc",
        fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      {children}
    </main>
  );
}

function Loading() {
  return (
    <StatusShell>
      <div style={{ textAlign: "center", color: "#858585", fontSize: 14 }}>Loading session…</div>
    </StatusShell>
  );
}

function NotFound({ id }: { id: string }) {
  return (
    <StatusShell>
      <div
        style={{
          textAlign: "center",
          padding: 32,
          background: "#252526",
          border: "1px solid #404040",
          borderRadius: 6,
          maxWidth: 480,
        }}
      >
        <div style={{ fontSize: 16, color: "#cccccc", marginBottom: 8 }}>Session not found</div>
        <div style={{ fontSize: 12, color: "#858585", marginBottom: 20, fontFamily: "monospace" }}>{id}</div>
        <Link href="/review" style={{ color: "#3794ff", textDecoration: "none", fontSize: 13 }}>
          ← Back to sessions
        </Link>
      </div>
    </StatusShell>
  );
}

function Errored({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <StatusShell>
      <div
        style={{
          textAlign: "center",
          padding: 32,
          background: "#252526",
          border: "1px solid #404040",
          borderRadius: 6,
          maxWidth: 520,
        }}
      >
        <div style={{ fontSize: 14, color: "#f48771", marginBottom: 10 }}>Failed to load session</div>
        <div style={{ fontSize: 12, color: "#858585", marginBottom: 20 }}>{message}</div>
        <button
          onClick={onRetry}
          style={{
            background: "#0e639c",
            color: "#fff",
            border: "none",
            padding: "6px 18px",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 13,
            marginRight: 8,
          }}
        >
          Retry
        </button>
        <Link href="/review" style={{ color: "#3794ff", textDecoration: "none", fontSize: 13, marginLeft: 8 }}>
          ← Back to sessions
        </Link>
      </div>
    </StatusShell>
  );
}
