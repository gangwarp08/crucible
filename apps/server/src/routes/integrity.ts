// P1.1 — browser → server integrity-event ingest.
//
// POST /sessions/:id/integrity accepts small batches of browser-reported
// integrity signals (tab blur, paste bursts, devtools, …) and funnels each
// accepted event through the standard telemetry path (logEvent → append-only
// `events` rows with server-side monotonic seq, actor "candidate").
//
// Trust posture: everything here is candidate-browser input — best-effort,
// spoofable, informational only. It is validated (Zod discriminated union),
// rate-limited server-side, and NEVER feeds evidence/evaluations (the
// isolation filter lives in evidence-extractor.ts / analysis-input.ts).

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { IntegrityEventSchema } from "@crucible/shared";
import { sessionRegistry } from "../services/registry.js";
import { requireSessionToken } from "../services/session-token.js";
import { logEvent } from "../services/telemetry.js";

const ParamsSchema = z.object({ id: z.string().uuid() });

/** Max events accepted in a single POST. */
export const INTEGRITY_BATCH_MAX = 20;

/** Server-side per-session cap: events admitted per rolling minute window.
 *  Beyond the cap events are dropped (a flooding client can't grow the events
 *  table unboundedly or skew the suspicion score by volume). The first drop of
 *  each window also appends a server-authored `integrity.rate_capped` marker
 *  so reviewers can see that capping happened (and the suspicion score counts
 *  it — flooding raises suspicion instead of hiding it). */
export const INTEGRITY_EVENTS_PER_MIN = 60;

/** Per-type reservation within the window: low-signal chatter (blur/focus,
 *  idle, fullscreen) is capped at 40/min so at least 20/min of headroom always
 *  remains for the high-signal types (paste_burst, devtools, copy — and the
 *  P6.3 webcam signals face_absent / multiple_faces, which are deliberately
 *  NOT in the low-signal set: they're rare by construction (consecutive-sample
 *  debounce client-side) and reviewers treat them as high-confidence flags, so
 *  they must never be drowned by blur/focus noise) — a client can't drown the
 *  interesting signals in noise. */
export const INTEGRITY_LOW_SIGNAL_PER_MIN = 40;

const LOW_SIGNAL_TYPES = new Set([
  "integrity.tab_blur",
  "integrity.tab_focus",
  "integrity.window_blur",
  "integrity.idle_gap",
  "integrity.fullscreen_exit",
]);

const WINDOW_MS = 60_000;

interface LimiterWindow {
  windowStart: number;    // epoch ms — start of the current minute window
  accepted: number;       // events admitted in this window (all types)
  acceptedLow: number;    // low-signal events admitted in this window
  dropped: number;        // events dropped in this window
  markerEmitted: boolean; // rate_capped marker emitted for this window yet?
}

// In-memory, per-session. Entries are tiny and self-reset each window; stale
// entries (window older than 2 windows) are swept on every admit call, and
// dead-session entries are also pruned in the route handler.
const limiter = new Map<string, LimiterWindow>();

/**
 * Admit integrity events (given by type, in order) for `sessionId` under the
 * per-minute caps. Returns one boolean per input: true = admitted. Exported
 * (with `now` injectable) so verify-integrity-events.ts can exercise the caps
 * deterministically without HTTP.
 */
export function admitIntegrityEvents(
  sessionId: string,
  types: readonly string[],
  now: number = Date.now(),
): boolean[] {
  // Sweep entries whose window started more than 2 windows ago so the map
  // can't leak state for sessions that stopped posting.
  for (const [sid, win] of limiter) {
    if (now - win.windowStart > 2 * WINDOW_MS) limiter.delete(sid);
  }

  let w = limiter.get(sessionId);
  if (!w || now - w.windowStart >= WINDOW_MS) {
    w = { windowStart: now, accepted: 0, acceptedLow: 0, dropped: 0, markerEmitted: false };
    limiter.set(sessionId, w);
  }

  const flags: boolean[] = [];
  for (const type of types) {
    const isLow = LOW_SIGNAL_TYPES.has(type);
    const admit =
      w.accepted < INTEGRITY_EVENTS_PER_MIN &&
      (!isLow || w.acceptedLow < INTEGRITY_LOW_SIGNAL_PER_MIN);
    if (admit) {
      w.accepted++;
      if (isLow) w.acceptedLow++;
    } else {
      w.dropped++;
      // Once per window: log + append a server-authored marker event so the
      // capping is visible to reviewers (logEvent no-ops for dead sessions
      // and never throws).
      if (!w.markerEmitted) {
        w.markerEmitted = true;
        console.warn(
          `[integrity] session=${sessionId} rate cap hit (${INTEGRITY_EVENTS_PER_MIN}/min total, ${INTEGRITY_LOW_SIGNAL_PER_MIN}/min low-signal); dropping overflow for the rest of this window`,
        );
        logEvent(sessionId, "integrity.rate_capped", "system", {});
      }
    }
    flags.push(admit);
  }
  return flags;
}

/** Test/lifecycle helper — forget a session's limiter state. */
export function resetIntegrityLimiter(sessionId?: string): void {
  if (sessionId) limiter.delete(sessionId);
  else limiter.clear();
}

const BodySchema = z.object({
  events: z.array(IntegrityEventSchema).max(INTEGRITY_BATCH_MAX),
});

export async function integrityRoutes(server: FastifyInstance) {
  const requireToken = requireSessionToken(
    (req) => (req.params as { id?: string }).id,
  );

  server.post<{ Params: { id: string } }>(
    "/sessions/:id/integrity",
    {
      // Belt-and-braces on top of the per-session admit cap: a well-behaved
      // client batches, so 30 posts/min is generous headroom.
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      preHandler: [requireToken],
    },
    async (request, reply) => {
      const idParse = ParamsSchema.safeParse(request.params);
      if (!idParse.success) {
        return reply.status(400).send({ error: "Invalid session id (must be uuid)" });
      }
      const sessionId = idParse.data.id;

      // Live sessions only — integrity signals are meaningless (and the
      // seq counter is unavailable) once the entry leaves the registry.
      const entry = sessionRegistry.get(sessionId);
      if (!entry || entry.status === "completed") {
        limiter.delete(sessionId); // prune limiter state for dead sessions
        return reply.status(409).send({ error: "session_not_live" });
      }

      const bodyParse = BodySchema.safeParse(request.body);
      if (!bodyParse.success) {
        return reply.status(400).send({ error: bodyParse.error.flatten() });
      }
      const events = bodyParse.data.events;

      const admitFlags = admitIntegrityEvents(sessionId, events.map((e) => e.type));
      let accepted = 0;
      events.forEach((e, i) => {
        if (!admitFlags[i]) return;
        accepted++;
        const payload: Record<string, unknown> = { ...(e.payload ?? {}) };
        if (e.ts !== undefined) payload.client_ts = e.ts; // client clock, informational
        logEvent(sessionId, e.type, "candidate", payload);
      });

      return reply.send({ accepted, dropped: events.length - accepted });
    },
  );
}
