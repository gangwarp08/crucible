"use client";
// Admin-only "Validity" nav link for the review dashboard. Probes the
// validity surface once on mount with the stored org key; renders only when
// the probe succeeds (admin org). Partner keys (403), missing key (401),
// and older servers without the routes all keep it hidden — probeValidityAccess
// never throws.
import { useEffect, useState } from "react";
import Link from "next/link";
import { probeValidityAccess } from "@/lib/api";
import { color, font, radius } from "@/styles/tokens";

export default function ValidityNavLink() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void probeValidityAccess().then((ok) => {
      if (!cancelled && ok) setVisible(true);
    });
    return () => { cancelled = true; };
  }, []);

  if (!visible) return null;
  return (
    <Link
      href="/review/validity"
      title="Validity instrumentation (asaya admin only)"
      style={{
        fontSize: 11,
        fontFamily: font.mono,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: color.accent.base,
        border: `1px solid ${color.border.default}`,
        borderRadius: radius.md,
        padding: "4px 10px",
        textDecoration: "none",
        whiteSpace: "nowrap",
      }}
    >
      Validity
    </Link>
  );
}
