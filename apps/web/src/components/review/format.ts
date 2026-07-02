// Shared formatters for the recruiter review UI.

export function asNumber(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return v;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const totalSecs = Math.round(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatSpend(usd: number | string | null | undefined): string {
  const n = asNumber(usd);
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(3)}`;
}

export function formatSpendPrecise(usd: number | string | null | undefined): string {
  const n = asNumber(usd);
  return `$${n.toFixed(6)}`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatDateShort(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatRelativeMs(deltaMs: number): string {
  if (deltaMs < 0) return "0:00";
  const totalSecs = Math.floor(deltaMs / 1000);
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Color-code an evaluation score 1-5. Aligns with the StatusBadge palette
 *  used elsewhere in /review (#4ec9b0 / #3794ff / #dcb67a / #f48771). */
export function scoreColor(score: number | null | undefined): string {
  if (typeof score !== "number" || Number.isNaN(score)) return "#858585";
  const s = Math.round(score);
  if (s >= 5) return "#4ec9b0";
  if (s >= 4) return "#3794ff";
  if (s >= 3) return "#dcb67a";
  return "#f48771";
}

/** "data_fluency" → "Data Fluency"; "ai_orchestration" → "Ai Orchestration"
 *  (special-case the AI acronym). */
export function prettyCompetency(key: string): string {
  return key
    .split("_")
    .map((w) => (w === "ai" ? "AI" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}
