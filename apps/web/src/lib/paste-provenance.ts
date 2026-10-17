"use client";
// Verification slice (detector v5) — client-side paste provenance.
//
// The single cleanest "second window" signal: a large paste whose text never
// appeared anywhere inside the sandbox UI. Panels that render text the
// candidate can legitimately copy (docs, brief, assistant replies, persona
// messages, terminal output, their own editor files) REGISTER that text here;
// the paste handler in lib/integrity.ts then CLASSIFIES each large paste:
//
//   internal — the paste matches registered text (full-block or most sampled
//              lines) → benign in-workspace copy;
//   external — nothing matches → the text came from outside the sandbox;
//   unknown  — partial/ambiguous match (e.g. candidate edited mid-copy).
//
// PRIVACY POSTURE: nothing leaves the browser from this module. Only SHA-256
// hashes of normalized text are kept, in a bounded in-memory registry that
// dies with the tab. The classification (one word) rides the existing
// integrity.paste_burst payload — the pasted text itself is never posted.
//
// Trust posture: client-side and best-effort like all of integrity.* —
// spoofable by a motivated candidate, informational-only, never scored
// against competency. A hash registry is still far better than nothing: the
// naive fraud path (paste from ChatGPT in another window) classifies cleanly.

/** Only pastes larger than this get classified (mirrors PASTE_BURST_CHARS in
 *  lib/integrity.ts — smaller pastes never emit a burst event at all). */
export const MIN_LINE_CHARS = 40; // lines shorter than this are too generic to hash

/** Bounded registry size. At ~5k entries × 16-char keys this is trivially
 *  small; insertion order eviction (Map preserves it) approximates LRU well
 *  enough for a 90-minute session. */
const MAX_ENTRIES = 5_000;

/** How many lines of a paste we sample for membership (first/last + evenly
 *  spaced middles). */
const SAMPLE_LINES = 5;

/** Fraction of sampled lines that must match for `internal`. */
const INTERNAL_MATCH_RATIO = 0.6;

export type PasteProvenance = "internal" | "external" | "unknown";

// Registry of hex-digest prefixes of normalized text chunks. Module-level —
// the workspace is a single SPA page; the registry naturally scopes to the
// tab/session and is GC'd on navigation.
const registry = new Map<string, true>();

// crypto.subtle is async; registration is fire-and-forget and pastes can race
// a slow registration. Acceptable: a race misclassifies toward `unknown`
// (never toward `external`-only false flags… a full miss IS external, but the
// window is milliseconds and sources register on render, long before a human
// can select + copy + paste).

function normalize(text: string): string {
  // Whitespace-insensitive: collapse all runs (incl. newlines) to one space.
  // Pastes reflowed by the clipboard or wrapped differently still match.
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

async function digest(text: string): Promise<string | null> {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    // 16 hex chars (64 bits) — collision-irrelevant for a 5k-entry allowlist.
    return Array.from(new Uint8Array(buf).slice(0, 8))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null; // non-secure context / ancient browser → provenance degrades to unknown
  }
}

function remember(key: string): void {
  if (registry.has(key)) {
    // refresh recency: Map iteration order is insertion order
    registry.delete(key);
  } else if (registry.size >= MAX_ENTRIES) {
    const oldest = registry.keys().next().value;
    if (oldest !== undefined) registry.delete(oldest);
  }
  registry.set(key, true);
}

/**
 * Register text that was RENDERED inside the sandbox (docs, brief, assistant
 * replies, persona messages, terminal output, editor file contents). Call on
 * render/update; cheap and idempotent. Fire-and-forget — never throws.
 *
 * Hashes the full normalized block plus each line ≥ MIN_LINE_CHARS so partial
 * copies of a long document still classify as internal.
 */
export function registerSandboxText(text: string): void {
  if (!text || text.length < MIN_LINE_CHARS) return;
  void (async () => {
    const full = await digest(normalize(text));
    if (full !== null) remember(full);
    // Per-line hashes (bounded: a pathological 100k-line blob must not flood
    // the registry — cap lines registered per call).
    const lines = text.split("\n");
    let registered = 0;
    for (const line of lines) {
      if (registered >= 500) break;
      const norm = normalize(line);
      if (norm.length < MIN_LINE_CHARS) continue;
      const h = await digest(norm);
      if (h !== null) {
        remember(h);
        registered++;
      }
    }
  })();
}

/**
 * Classify a paste against the registry. Called by the paste handler in
 * lib/integrity.ts for bursts over its threshold. Never throws.
 */
export async function classifyPaste(text: string): Promise<PasteProvenance> {
  try {
    const full = await digest(normalize(text));
    if (full !== null && registry.has(full)) return "internal";

    // Sample up to SAMPLE_LINES qualifying lines, spread across the paste.
    const lines = text.split("\n").map(normalize).filter((l) => l.length >= MIN_LINE_CHARS);
    if (lines.length === 0) {
      // A >400-char paste with no hashable line (one long unbroken line that
      // isn't registered as a block) — can't attribute it either way.
      return "unknown";
    }
    const picks: string[] = [];
    if (lines.length <= SAMPLE_LINES) {
      picks.push(...lines);
    } else {
      for (let i = 0; i < SAMPLE_LINES; i++) {
        picks.push(lines[Math.floor((i * (lines.length - 1)) / (SAMPLE_LINES - 1))]!);
      }
    }
    let hits = 0;
    for (const line of picks) {
      const h = await digest(line);
      if (h !== null && registry.has(h)) hits++;
    }
    if (hits === 0) return "external";
    return hits / picks.length >= INTERNAL_MATCH_RATIO ? "internal" : "unknown";
  } catch {
    return "unknown";
  }
}

/** Test-only: reset the registry between fixture runs. */
export function __resetPasteProvenance(): void {
  registry.clear();
}
