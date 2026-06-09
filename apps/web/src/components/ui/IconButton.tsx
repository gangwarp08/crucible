"use client";
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { color, radius } from "@/styles/tokens";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  label: string;       // required for a11y — used as aria-label + title
  size?: number;       // px square
  variant?: "ghost" | "soft";
}

export default function IconButton({
  icon, label, size = 28, variant = "ghost", style, disabled, ...rest
}: Props): React.ReactElement {
  const base: CSSProperties = {
    width: size,
    height: size,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: variant === "soft" ? color.bg.elevated : "transparent",
    color: disabled ? color.text.muted : color.text.secondary,
    border: variant === "soft" ? `1px solid ${color.border.default}` : "1px solid transparent",
    borderRadius: radius.sm,
    cursor: disabled ? "not-allowed" : "pointer",
    padding: 0,
    ...style,
  };
  return (
    <button {...rest} aria-label={label} title={label} disabled={disabled} style={base}>
      {icon}
    </button>
  );
}
