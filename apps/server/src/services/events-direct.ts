// Registry-bypass event writer.
//
// The standard logEvent path (services/telemetry.ts) requires the session's
// SessionEntry to be live in memory — it allocates a seq from the entry's
// monotonic counter and buffers on the entry. That's fine for the auto-eval
// path (entry still in registry when expireSession runs), but the manual
// re-evaluate path can fire days later against a session whose entry has
// been evicted from memory (or whose process restarted entirely).
//
// appendEvent transparently picks the right path:
//   - registry entry present → delegate to logEvent (fast, batched, in-order)
//   - entry missing          → direct Supabase insert with seq = MAX(seq)+1
//
// The direct path is single-actor (only the analysis agent calls it for a
// completed session), so the read-then-insert race is benign for now.

import { randomUUID } from "crypto";
import { sessionRegistry } from "./registry.js";
import { logEvent } from "./telemetry.js";
import { supabase } from "./supabase.js";

export async function appendEvent(
  sessionId: string,
  type: string,
  actor: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const entry = sessionRegistry.get(sessionId);
  if (entry) {
    logEvent(sessionId, type, actor, payload);
    return;
  }

  if (!supabase) return;

  try {
    // Allocate the next seq for this session. MAX(seq) returns null when no
    // rows exist; treat null as -1 so the first inserted row gets seq 0.
    const { data: maxRow, error: maxErr } = await supabase
      .from("events")
      .select("seq")
      .eq("session_id", sessionId)
      .order("seq", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (maxErr) {
      console.error("[events-direct] MAX(seq) read failed", maxErr.message);
      return;
    }

    const nextSeq = ((maxRow?.seq as number | null | undefined) ?? -1) + 1;

    const { error: insErr } = await supabase.from("events").insert({
      id: randomUUID(),
      session_id: sessionId,
      seq: nextSeq,
      type,
      actor,
      ts: new Date().toISOString(),
      payload,
    });

    if (insErr) {
      console.error("[events-direct] insert failed", insErr.message);
    }
  } catch (err) {
    console.error("[events-direct] unexpected error", err);
  }
}
