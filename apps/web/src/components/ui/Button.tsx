"use client";
import Link from "next/link";
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { color, radius, size as fontSize, font } from "@/styles/tokens";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "size"> {
  variant?: Variant;
  size?: Size;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  fullWidth?: boolean;
  /** When set, renders an anchor (via next/link) styled as a button —
   *  avoids the invalid button-nested-in-anchor pattern for CTAs. */
  href?: string;
}

const SIZE_STYLE: Record<Size, CSSProperties> = {
  sm: { padding: "6px 12px", fontSize: 11.5, height: 28, gap: 8 },
  md: { padding: "9px 16px", fontSize: 12, height: 36, gap: 8 },
  lg: { padding: "13px 22px", fontSize: 12.5, height: 44, gap: 10 },
};

function variantStyle(variant: Variant, disabled: boolean): CSSProperties {
  if (variant === "primary") {
    if (disabled) {
      return {
        background: color.bg.elevated,
        color: color.text.muted,
        border: `1px solid ${color.border.default}`,
        fontFamily: font.mono,
        fontWeight: 600,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
      };
    }
    return {
      background: color.accent.base,
      color: color.text.inverse,
      border: "1px solid transparent",
      fontFamily: font.mono,
      fontWeight: 600,
      letterSpacing: "0.12em",
      textTransform: "uppercase",
    };
  }
  if (variant === "secondary") {
    return disabled
      ? { background: "transparent", color: color.text.muted, border: `1px solid ${color.border.subtle}` }
      : { background: color.bg.elevated, color: color.text.primary, border: `1px solid ${color.border.default}` };
  }
  if (variant === "danger") {
    return disabled
      ? { background: color.bg.elevated, color: color.text.muted, border: `1px solid ${color.border.default}` }
      : { background: color.error.soft, color: color.error.base, border: `1px solid ${color.error.base}` };
  }
  // ghost — uses the CTA typographic system to pair with primary
  if (disabled) {
    return {
      background: "transparent",
      color: color.text.muted,
      border: `1px solid ${color.border.subtle}`,
      fontFamily: font.mono,
      fontWeight: 500,
      letterSpacing: "0.12em",
      textTransform: "uppercase",
    };
  }
  return {
    background: "transparent",
    color: color.text.primary,
    border: `1px solid ${color.border.strong}`,
    fontFamily: font.mono,
    fontWeight: 500,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
  };
}

export default function Button({
  variant = "primary",
  size = "md",
  leadingIcon,
  trailingIcon,
  fullWidth,
  disabled,
  style,
  children,
  className,
  href,
  ...rest
}: Props): React.ReactElement {
  const merged: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: font.sans,
    fontWeight: 500,
    borderRadius: radius.sm,
    cursor: disabled ? "not-allowed" : "pointer",
    whiteSpace: "nowrap",
    width: fullWidth ? "100%" : undefined,
    lineHeight: 1,
    ...SIZE_STYLE[size],
    ...variantStyle(variant, !!disabled),
    ...style,
  };
  // Variant-specific classes drive hover behavior (glow + lift) from
  // globals.css — inline styles can't express :hover.
  const variantClass =
    variant === "primary" ? "btn-cta-primary"
    : variant === "ghost" ? "btn-cta-ghost"
    : "";
  const cls = [variantClass, className].filter(Boolean).join(" ");
  const content = (
    <>
      {leadingIcon && <span style={{ display: "inline-flex" }}>{leadingIcon}</span>}
      {children !== undefined && children !== null && children !== false && (
        <span style={{ display: "inline-flex" }}>{children}</span>
      )}
      {trailingIcon && <span style={{ display: "inline-flex" }}>{trailingIcon}</span>}
    </>
  );
  if (href && !disabled) {
    return (
      <Link href={href} role="button" style={{ ...merged, textDecoration: "none" }} className={cls || undefined}>
        {content}
      </Link>
    );
  }
  return (
    <button {...rest} disabled={disabled} style={merged} className={cls || undefined}>
      {content}
    </button>
  );
}

// Suppress unused-import warning for fontSize (kept for downstream extension).
void fontSize;
