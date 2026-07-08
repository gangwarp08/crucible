"use client";
// Admin-only nav links for the review dashboard (generalizes the former
// ValidityNavLink). Each surface is probed once on mount with the stored org
// key; a link renders only when its probe succeeds (admin org). Partner keys
// (403), missing key (401), and older servers without the routes all keep the
// link hidden — the probe helpers never throw.
import { useEffect, useState } from "react";
import Link from "next/link";
import { probeCostsAccess, probeValidityAccess } from "@/lib/api";
import { color, font, radius } from "@/styles/tokens";

const LINKS: Array<{
  href: string;
  label: string;
  title: string;
  probe: () => Promise<boolean>;
}> = [
  {
    href: "/review/validity",
    label: "Validity",
    title: "Validity instrumentation (asaya admin only)",
    probe: probeValidityAccess,
  },
  {
    href: "/review/costs",
    label: "Costs",
    title: "Costs dashboard (asaya admin only)",
    probe: probeCostsAccess,
  },
];

export default function AdminNavLinks() {
  const [visible, setVisible] = useState<boolean[]>(() => LINKS.map(() => false));

  useEffect(() => {
    let cancelled = false;
    LINKS.forEach((link, i) => {
      void link.probe().then((ok) => {
        if (cancelled || !ok) return;
        setVisible((prev) => {
          const next = [...prev];
          next[i] = true;
          return next;
        });
      });
    });
    return () => { cancelled = true; };
  }, []);

  const shown = LINKS.filter((_, i) => visible[i]);
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          title={link.title}
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
          {link.label}
        </Link>
      ))}
    </>
  );
}
