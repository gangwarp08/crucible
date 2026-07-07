"use client";
// P4.3 — mint / list / revoke shareable report links for one session.
// The RAW token appears exactly once (right after minting); the copyable URL
// is <site origin>/report/<token>, served by the PUBLIC shared-report page.
// Everything here talks to org-gated /api/review routes; the recipient of the
// link never needs an org key.
import { useCallback, useEffect, useState } from "react";
import {
  mintReportShare,
  listReportShares,
  revokeReportShare,
  type ReportShareSummary,
} from "@/lib/api";
import { formatDateShort } from "./format";
import { color, radius, font, shadow } from "@/styles/tokens";

const DEFAULT_TTL_HOURS = 168; // 7 days
const MAX_TTL_HOURS = 720;     // 30 days — server-enforced cap

export default function ShareReportModal({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button onClick={() => setOpen(true)} style={openBtn}>
        Share report
      </button>
      {open && <Modal sessionId={sessionId} onClose={() => setOpen(false)} />}
    </>
  );
}

function Modal({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [shares, setShares] = useState<ReportShareSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ttlHours, setTtlHours] = useState(DEFAULT_TTL_HOURS);
  const [minting, setMinting] = useState(false);
  // The freshly minted URL — shown ONCE; it is not recoverable after closing.
  const [freshUrl, setFreshUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setShares(await listReportShares(sessionId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load share links");
    }
  }, [sessionId]);
  useEffect(() => { void load(); }, [load]);

  async function mint() {
    setMinting(true);
    setError(null);
    setCopied(false);
    try {
      const { token } = await mintReportShare(sessionId, ttlHours);
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      setFreshUrl(`${origin}/report/${token}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to mint share link");
    } finally {
      setMinting(false);
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      await revokeReportShare(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke share link");
    }
  }

  async function copy() {
    if (!freshUrl) return;
    try {
      await navigator.clipboard.writeText(freshUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — user can select the text manually */
    }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <header style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: color.text.primary, letterSpacing: "0.05em", textTransform: "uppercase" }}>
            Shareable report links
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={closeBtn}>✕</button>
        </header>

        <p style={{ fontSize: 12, color: color.text.secondary, lineHeight: 1.55, margin: "0 0 14px" }}>
          Anyone with the link sees the external-safe candidate report only — no cost,
          no raw transcript, no other candidates. Links expire and can be revoked here.
        </p>

        {error && (
          <div style={{ background: color.error.soft, color: color.error.base, padding: "8px 12px", borderRadius: radius.lg, fontSize: 12, marginBottom: 12, wordBreak: "break-word" }}>
            {error}
          </div>
        )}

        {/* Mint */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <label style={{ fontSize: 12, color: color.text.secondary, display: "flex", alignItems: "center", gap: 6 }}>
            Expires in
            <input
              type="number"
              min={1}
              max={MAX_TTL_HOURS}
              value={ttlHours}
              onChange={(e) => {
                const n = Number(e.target.value);
                setTtlHours(Number.isFinite(n) ? Math.max(1, Math.min(MAX_TTL_HOURS, Math.round(n))) : DEFAULT_TTL_HOURS);
              }}
              style={ttlInput}
            />
            hours
          </label>
          <button onClick={() => void mint()} disabled={minting} style={mintBtn(minting)}>
            {minting ? "Minting…" : "Create link"}
          </button>
        </div>

        {/* Fresh URL — visible once */}
        {freshUrl && (
          <div style={{ background: color.accent.soft, border: `1px solid ${color.accent.glow}`, borderRadius: radius.lg, padding: "10px 12px", marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: color.accent.base, fontWeight: 600, marginBottom: 6 }}>
              Copy this link now — it won&apos;t be shown again.
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <code style={{ fontSize: 11, fontFamily: font.mono, color: color.text.primary, wordBreak: "break-all", flex: 1 }}>
                {freshUrl}
              </code>
              <button
                onClick={() => void copy()}
                style={{ ...copyBtn, ...(copied ? { color: color.success.base, borderColor: color.success.base } : {}) }}
              >
                {copied ? "Copied ✓" : "Copy"}
              </button>
            </div>
          </div>
        )}

        {/* Existing links */}
        {shares === null ? (
          <div style={{ fontSize: 12, color: color.text.muted }}>Loading…</div>
        ) : shares.length === 0 ? (
          <div style={{ fontSize: 12, color: color.text.muted }}>No share links yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {shares.map((s) => (
              <div
                key={s.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 10px",
                  background: color.bg.page,
                  border: `1px solid ${color.border.subtle}`,
                  borderRadius: radius.lg,
                  fontSize: 12,
                }}
              >
                <StatusDot status={s.status} />
                <span style={{ color: color.text.secondary }}>
                  created {formatDateShort(s.created_at)} · expires {formatDateShort(s.expires_at)}
                </span>
                <div style={{ flex: 1 }} />
                {s.status === "active" && (
                  <button onClick={() => void revoke(s.id)} style={revokeBtn}>
                    Revoke
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: ReportShareSummary["status"] }) {
  const c =
    status === "active" ? color.success.base : status === "revoked" ? color.error.base : color.text.muted;
  return (
    <span style={{ color: c, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
      ● {status}
    </span>
  );
}

// ── styles ───────────────────────────────────────────────────────────────────

const openBtn: React.CSSProperties = {
  background: "transparent",
  color: color.accent.base,
  border: `1px solid ${color.border.strong}`,
  borderRadius: radius.lg,
  padding: "6px 14px",
  fontSize: 12,
  cursor: "pointer",
};

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 100,
  padding: 24,
};

const panel: React.CSSProperties = {
  background: color.bg.panel,
  border: `1px solid ${color.border.default}`,
  borderRadius: radius.md,
  boxShadow: shadow.lg,
  padding: 20,
  width: "100%",
  maxWidth: 620,
  maxHeight: "80vh",
  overflowY: "auto",
};

const closeBtn: React.CSSProperties = {
  background: "transparent",
  color: color.text.secondary,
  border: "none",
  fontSize: 14,
  cursor: "pointer",
  padding: 4,
};

const ttlInput: React.CSSProperties = {
  width: 70,
  background: color.bg.input,
  color: color.text.primary,
  border: `1px solid ${color.border.strong}`,
  borderRadius: radius.lg,
  padding: "5px 8px",
  fontSize: 12,
  fontFamily: font.mono,
  outline: "none",
};

function mintBtn(disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? color.bg.elevated : color.accent.base,
    color: disabled ? color.text.secondary : color.text.inverse,
    border: "none",
    borderRadius: radius.lg,
    padding: "6px 14px",
    fontSize: 12,
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

const copyBtn: React.CSSProperties = {
  background: "transparent",
  color: color.accent.base,
  border: `1px solid ${color.border.strong}`,
  borderRadius: radius.lg,
  padding: "4px 12px",
  fontSize: 11,
  cursor: "pointer",
  flexShrink: 0,
};

const revokeBtn: React.CSSProperties = {
  background: "transparent",
  color: color.error.base,
  border: `1px solid ${color.border.default}`,
  borderRadius: radius.lg,
  padding: "3px 10px",
  fontSize: 11,
  cursor: "pointer",
};
