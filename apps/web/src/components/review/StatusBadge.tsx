"use client";
import Pill, { type PillTone } from "@/components/ui/Pill";

const STATUS_TONE: Record<string, PillTone> = {
  completed: "success",
  timed_out: "warn",
  active:    "accent",
  error:     "error",
  aborted:   "neutral",
};

const STATUS_LABEL: Record<string, string> = {
  completed: "Completed",
  timed_out: "Expired",
  active:    "Active",
  error:     "Error",
  aborted:   "Aborted",
};

export default function StatusBadge({
  status, size = "sm",
}: { status: string; size?: "sm" | "md" }) {
  return (
    <Pill tone={STATUS_TONE[status] ?? "neutral"} size={size}>
      {STATUS_LABEL[status] ?? status}
    </Pill>
  );
}
