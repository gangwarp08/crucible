"use client";
// Link-embedded partner access for the review surface: /review?key=<org key>.
//
// Partners get a single URL (printed by scripts/mint-org-key.ts) instead of a
// separate key exchange. On load we move the key into the existing
// sessionStorage slot (crucible.org.key — the same one OrgKeyInput manages and
// lib/api.ts reads for the X-Org-Key header), then immediately strip it from
// the address bar via history.replaceState so it never lingers in the URL or
// browser history.
//
// Referrer caveat: replaceState scrubs the address bar and history, but the
// initial navigation itself can still leak the full URL via the Referer header
// on requests that fire before the strip. Modern browsers default to
// strict-origin-when-cross-origin (origin-only Referer cross-origin), which
// contains this, but partners should still treat the link as a secret.
import { useState } from "react";
import { storeOrgKey } from "@/lib/api";

function bootstrapOrgKeyFromUrl(): null {
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(window.location.href);
    const key = url.searchParams.get("key");
    if (key === null) return null;
    if (key.trim()) storeOrgKey(key.trim());
    url.searchParams.delete("key");
    window.history.replaceState(window.history.state, "", url.toString());
  } catch {
    /* never let bootstrap break the review surface */
  }
  return null;
}

export default function OrgKeyBootstrap() {
  // useState initializer, not useEffect: it runs synchronously during the first
  // client render — this component is mounted by the review layout BEFORE the
  // page children, so the key is already in sessionStorage when any child's
  // data-fetching effect issues its first /api/review/* call. (Idempotent, so
  // StrictMode's double invocation is harmless.)
  useState(bootstrapOrgKeyFromUrl);
  return null;
}
