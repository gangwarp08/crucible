"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSession } from "@/lib/api";

export default function HomePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startSession() {
    setLoading(true);
    setError(null);
    try {
      const { sessionId } = await createSession();
      router.push(`/session/${sessionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start session");
      setLoading(false);
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#1e1e1e",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
        color: "#cccccc",
      }}
    >
      <div style={{ textAlign: "center", maxWidth: 400 }}>
        <h1
          style={{
            fontSize: 32,
            fontWeight: 600,
            marginBottom: 8,
            color: "#ffffff",
            letterSpacing: "-0.5px",
          }}
        >
          Crucible
        </h1>
        <p style={{ color: "#858585", marginBottom: 40, fontSize: 15 }}>
          AI-conducted coding assessment platform
        </p>
        <button
          onClick={() => { void startSession(); }}
          disabled={loading}
          style={{
            background: loading ? "#37373d" : "#0e639c",
            color: "#ffffff",
            border: "none",
            padding: "12px 36px",
            fontSize: 15,
            fontWeight: 500,
            borderRadius: 4,
            cursor: loading ? "not-allowed" : "pointer",
            transition: "background 0.15s",
          }}
          onMouseEnter={(e) => {
            if (!loading)
              (e.currentTarget as HTMLButtonElement).style.background = "#1177bb";
          }}
          onMouseLeave={(e) => {
            if (!loading)
              (e.currentTarget as HTMLButtonElement).style.background = "#0e639c";
          }}
        >
          {loading ? "Starting…" : "Start Assessment"}
        </button>
        {error && (
          <p style={{ color: "#f48771", marginTop: 16, fontSize: 13 }}>{error}</p>
        )}
      </div>
    </main>
  );
}
