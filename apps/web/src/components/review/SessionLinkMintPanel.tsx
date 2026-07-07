"use client";
// RD6 admin side + P5.1: mint a single-use candidate session link, optionally
// requesting a difficulty band. The band is consumed ONCE, at session
// creation, where the canonical scenario is routed to its family sibling in
// that band (server: services/difficulty-routing.ts). The RAW token is shown
// exactly once — only its hash is stored.
import { useEffect, useState } from "react";
import {
  listScenarios,
  getScenarioBySlug,
  getStoredInviteCode,
  createReviewSessionLink,
  type ScenarioCatalogItem,
  type SessionLinkDifficultyBand,
} from "@/lib/api";
import { color, radius, font } from "@/styles/tokens";

const BANDS: SessionLinkDifficultyBand[] = ["easy", "mid", "hard"];

function isBand(v: string | null | undefined): v is SessionLinkDifficultyBand {
  return !!v && (BANDS as string[]).includes(v);
}

const inputStyle: React.CSSProperties = {
  background: color.bg.input,
  color: color.text.primary,
  border: `1px solid ${color.border.strong}`,
  borderRadius: radius.lg,
  padding: "5px 8px",
  fontSize: 12,
  outline: "none",
  fontFamily: "inherit",
};

export default function SessionLinkMintPanel() {
  const [scenarios, setScenarios] = useState<ScenarioCatalogItem[]>([]);
  const [label, setLabel] = useState("");
  const [slug, setSlug] = useState("");
  // "" = no routing (band-less link starts the scenario as published).
  const [band, setBand] = useState<string>("");
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<{ token: string; url: string | null } | null>(null);

  useEffect(() => {
    // Catalog is candidate-gated when INVITE_CODE is set; a failure here just
    // means the scenario picker is empty (label-only links still mint).
    listScenarios(getStoredInviteCode() ?? undefined)
      .then(setScenarios)
      .catch(() => setScenarios([]));
  }, []);

  function onScenarioChange(nextSlug: string) {
    setSlug(nextSlug);
    // P5.1 default: the scenario's own band (routing to itself = no swap).
    const difficulty = scenarios.find((s) => s.slug === nextSlug)?.difficulty;
    setBand(isBand(difficulty) ? difficulty : "");
  }

  async function mint() {
    setError(null);
    setMinted(null);
    setMinting(true);
    try {
      // The review API wants the scenario UUID; the catalog carries slugs.
      let scenarioId: string | undefined;
      if (slug) {
        const sc = await getScenarioBySlug(slug, getStoredInviteCode() ?? undefined);
        scenarioId = sc.id;
      }
      const { token } = await createReviewSessionLink({
        candidateLabel: label,
        ...(scenarioId ? { scenarioId } : {}),
        ...(isBand(band) ? { difficultyBand: band } : {}),
      });
      const url = slug
        ? `${window.location.origin}/start/${encodeURIComponent(slug)}?link=${encodeURIComponent(token)}`
        : null;
      setMinted({ token, url });
      setLabel("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to mint link");
    } finally {
      setMinting(false);
    }
  }

  return (
    <div
      style={{
        background: color.bg.panel,
        border: `1px solid ${color.border.default}`,
        borderRadius: radius.md,
        padding: "14px 16px",
        marginBottom: 20,
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 600, color: color.text.secondary, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
        Mint candidate link
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap", fontSize: 12, color: color.text.secondary }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          Candidate
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Jane D — FDE loop"
            style={{ ...inputStyle, width: 220 }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          Scenario
          <select value={slug} onChange={(e) => onScenarioChange(e.target.value)} style={inputStyle}>
            <option value="">— none —</option>
            {scenarios.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.title}{s.difficulty ? ` (${s.difficulty})` : ""}
              </option>
            ))}
          </select>
        </label>
        {/* P5.1: requested band — defaults to the scenario's own band. */}
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          Band
          <select value={band} onChange={(e) => setBand(e.target.value)} style={inputStyle}>
            <option value="">default (no routing)</option>
            {BANDS.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </label>
        <button
          onClick={() => void mint()}
          disabled={minting || label.trim().length === 0}
          style={{
            background: color.accent.base,
            color: color.text.inverse,
            border: "none",
            padding: "6px 16px",
            borderRadius: radius.lg,
            cursor: minting || label.trim().length === 0 ? "default" : "pointer",
            opacity: minting || label.trim().length === 0 ? 0.5 : 1,
            fontSize: 12,
          }}
        >
          {minting ? "Minting…" : "Mint link"}
        </button>
      </div>
      {error && (
        <div style={{ color: color.error.base, fontSize: 12, marginTop: 10 }}>{error}</div>
      )}
      {minted && (
        <div style={{ marginTop: 10, fontSize: 12, color: color.text.secondary }}>
          Shown once — copy it now:
          <div style={{ fontFamily: font.mono, fontSize: 11, color: color.text.primary, marginTop: 4, wordBreak: "break-all", userSelect: "all" }}>
            {minted.url ?? minted.token}
          </div>
        </div>
      )}
    </div>
  );
}
