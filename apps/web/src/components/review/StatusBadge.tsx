"use client";

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  completed: { bg: "#1e3a2e", fg: "#4ec9b0" },
  timed_out: { bg: "#3a2e1e", fg: "#dcb67a" },
  active:    { bg: "#0e2a44", fg: "#3794ff" },
  error:     { bg: "#3a1e1e", fg: "#f48771" },
  aborted:   { bg: "#2a2a2a", fg: "#858585" },
};

const STATUS_LABEL: Record<string, string> = {
  completed: "Completed",
  timed_out: "Expired",
  active:    "Active",
  error:     "Error",
  aborted:   "Aborted",
};

export default function StatusBadge({ status, size = "sm" }: { status: string; size?: "sm" | "md" }) {
  const colors = STATUS_COLORS[status] ?? { bg: "#2a2a2a", fg: "#cccccc" };
  const pad = size === "md" ? "4px 12px" : "2px 8px";
  const fontSize = size === "md" ? 12 : 11;
  return (
    <span
      style={{
        display: "inline-block",
        padding: pad,
        borderRadius: 10,
        fontSize,
        fontWeight: 500,
        background: colors.bg,
        color: colors.fg,
        letterSpacing: "0.02em",
        whiteSpace: "nowrap",
      }}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}
