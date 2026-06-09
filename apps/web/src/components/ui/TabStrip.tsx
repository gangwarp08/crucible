"use client";
import type { CSSProperties, ReactNode } from "react";
import { color, font, radius } from "@/styles/tokens";

export interface TabSpec<Id extends string> {
  id: Id;
  label: string;
  icon?: ReactNode;
  badge?: number | string | null;   // numeric or short string; null hides
  disabled?: boolean;
}

interface Props<Id extends string> {
  tabs: ReadonlyArray<TabSpec<Id>>;
  value: Id;
  onChange: (id: Id) => void;
  variant?: "underline" | "pill";
  iconOnly?: boolean;              // narrow-mode: show icons only with title
  style?: CSSProperties;
}

/** Two variants:
 *  - underline: full-width strip, bottom-border accent for active. Used as
 *    the top-level tab navigator (workspace right column).
 *  - pill: compact, fills with accent-soft when active. Used for nested
 *    sub-tabs (Messages client/team). */
export default function TabStrip<Id extends string>({
  tabs, value, onChange, variant = "underline", iconOnly = false, style,
}: Props<Id>): React.ReactElement {
  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        background: variant === "underline" ? color.bg.elevated : "transparent",
        borderBottom: variant === "underline" ? `1px solid ${color.border.subtle}` : "none",
        flexShrink: 0,
        userSelect: "none",
        overflowX: "auto",
        gap: variant === "pill" ? 4 : 0,
        padding: variant === "pill" ? 4 : 0,
        ...style,
      }}
    >
      {tabs.map((t) => {
        const active = t.id === value;
        const disabled = !!t.disabled;
        const isUnderline = variant === "underline";
        const cell: CSSProperties = {
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: isUnderline ? (iconOnly ? "8px 12px" : "8px 14px") : "6px 12px",
          background: !active
            ? "transparent"
            : isUnderline ? color.accent.soft : color.accent.soft,
          border: "none",
          borderBottom: isUnderline
            ? `2px solid ${active ? color.accent.base : "transparent"}`
            : "none",
          borderRadius: isUnderline ? 0 : radius.sm,
          color: disabled ? color.text.muted : active ? color.text.primary : color.text.secondary,
          fontFamily: font.sans,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          cursor: disabled ? "not-allowed" : "pointer",
          whiteSpace: "nowrap",
          flexShrink: 0,
          position: "relative",
        };
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            aria-controls={`panel-${t.id}`}
            title={iconOnly ? t.label : undefined}
            disabled={disabled}
            onClick={() => onChange(t.id)}
            style={cell}
          >
            {t.icon && <span style={{ display: "inline-flex" }}>{t.icon}</span>}
            {!iconOnly && <span>{t.label}</span>}
            {t.badge !== null && t.badge !== undefined && t.badge !== 0 && t.badge !== "" && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minWidth: 16,
                  height: 16,
                  padding: "0 5px",
                  borderRadius: 999,
                  background: color.accent.base,
                  color: "#ffffff",
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: 0,
                }}
              >
                {t.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
