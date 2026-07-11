import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createSandbox, destroySandbox } from "../services/sandbox.js";
import { DatasetUnavailableError } from "../services/dataset-seed.js";
import { sessionRegistry } from "../services/registry.js";
import { getOrRehydrateSession } from "../services/session-rehydrate.js";
import { sumTodaySpendUsd } from "../services/db.js";
import { signToken, requireSessionToken } from "../services/session-token.js";
import {
  peekSessionLink,
  consumeSessionLink,
  SessionLinkError,
} from "../services/session-link.js";
import { getDefaultOrg, orgsTableKnownToExist, sessionOrgIdFromLink } from "../services/orgs.js";
import { resolveScenarioForBand, type DifficultyBand } from "../services/difficulty-routing.js";
import { recordNetworkObservation } from "../services/geo-integrity.js";
import { env } from "../env.js";

// Optional body. Missing body, empty body, and {} are all "no scenario" — the
// session boots in the legacy generic mode. When scenarioId is present the
// session is tied to that FDE simulation.
//
// `beatTimingOverridesMs` is a dev/test knob — maps a scenario curveball id
// to an absolute offset-in-ms from session start, replacing the value computed
// from `scenario.curveballs[*].trigger.time_offset_minutes`. Production
// callers (the web app) omit it. Verifier scripts use it to compress the
// 25-minute requirement-change beat into a 15-second wait.
const PostSessionBody = z
  .object({
    scenarioId: z.string().uuid().optional(),
    beatTimingOverridesMs: z.record(z.string(), z.number().int().nonnegative()).optional(),
    // Dev/test only — overrides scenario.constraints.tokens for this session.
    // Used by the AI-assistant verifier to force token exhaustion in a few calls.
    tokenBudgetOverride: z.number().int().nonnegative().optional(),
    // Shared invite code. Required only when env.INVITE_CODE is set.
    inviteCode: z.string().optional(),
    // RD6: single-use, candidate-bound session link. Required when
    // env.SESSION_LINK_REQUIRED is set; consumed atomically on first start.
    linkToken: z.string().optional(),
  })
  .optional();

export async function sessionRoutes(server: FastifyInstance) {
  // POST /sessions — boot a sandbox, mint a key, start the kill-switch timer.
  server.post("/", async (request, reply) => {
    const parsed = PostSessionBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid body",
        details: parsed.error.flatten().fieldErrors,
      });
    }
    if (env.INVITE_CODE && parsed.data?.inviteCode !== env.INVITE_CODE) {
      return reply.status(401).send({ error: "Invalid invite code" });
    }

    // H2 (6.8b): global daily spend circuit breaker — refuse new sessions once
    // the platform's spend for the day hits the ceiling. FAIL-CLOSED: if we
    // can't measure spend, deny rather than risk an unbounded-cost run.
    try {
      const todaySpend = await sumTodaySpendUsd();
      if (todaySpend >= env.GLOBAL_DAILY_SPEND_CEILING_USD) {
        request.log.warn(
          { todaySpend, ceiling: env.GLOBAL_DAILY_SPEND_CEILING_USD },
          "global daily spend ceiling reached — refusing new session",
        );
        return reply.status(503).send({
          error: "global_spend_ceiling",
          message: "The platform has reached its daily spend limit. Please try again tomorrow.",
        });
      }
    } catch (err) {
      request.log.error({ err }, "global spend check failed — failing closed (503)");
      return reply.status(503).send({
        error: "spend_check_unavailable",
        message: "Unable to verify platform capacity right now. Please try again shortly.",
      });
    }

    // RD6 single-use session link. When SESSION_LINK_REQUIRED, a link is
    // mandatory. Pre-validate here (cheap read) so a dead link never pays for a
    // sandbox; the authoritative single-use consume happens AFTER creation and
    // atomically binds the link to this session.
    const linkToken = parsed.data?.linkToken;
    const linkRequired = (env.SESSION_LINK_REQUIRED ?? "").toLowerCase() === "true";
    if (linkRequired && !linkToken) {
      return reply.status(401).send({ error: "session_link_required", message: "A session link is required to start." });
    }
    // P2: the session row's org comes from the consumed link's org when a
    // linkToken is used (the link is the tenant authority — the partner who
    // minted it owns the resulting session), else the default 'asaya' org.
    // Resolved BEFORE sandbox creation because persistSessionCreated runs
    // inside createSandbox and sessions.org_id is NOT NULL after 0018.
    let linkOrgId: string | null = null;
    // P5.1: band the recruiter requested when minting the link (0022).
    // Null = no routing. Consumed once, below, BEFORE sandbox creation.
    let linkBand: DifficultyBand | null = null;
    if (linkToken) {
      try {
        const link = await peekSessionLink(linkToken);
        linkOrgId = link.org_id;
        linkBand = link.difficulty_band;
      } catch (err) {
        if (err instanceof SessionLinkError) {
          return reply.status(err.code === "invalid" ? 401 : 409).send({
            error: `session_link_${err.code}`,
            message: err.message,
          });
        }
        throw err;
      }
    }
    let sessionOrgId: string | undefined;
    try {
      sessionOrgId = sessionOrgIdFromLink(linkOrgId, (await getDefaultOrg())?.id);
    } catch (err) {
      // Post-0018 the orgs table exists; a transient default-org failure must
      // fail the request (getDefaultOrg only throws once the table has been
      // seen), never fall through to a tenant-less session row.
      request.log.error({ err }, "org resolution failed — refusing session create");
      return reply.status(503).send({
        error: "org_resolution_failed",
        message: "Unable to resolve the owning organization right now. Please try again shortly.",
      });
    }
    if (!sessionOrgId && orgsTableKnownToExist()) {
      // Same post-migration safety as persistSessionCreated: the orgs table
      // exists (0018 applied) so sessions.org_id is NOT NULL — starting a
      // session without a tenant would only die later on the insert.
      request.log.error(
        "orgs table exists but no org could be resolved (link org + default org both null) — refusing session create",
      );
      return reply.status(503).send({
        error: "org_resolution_failed",
        message: "Unable to resolve the owning organization right now. Please try again shortly.",
      });
    }

    const scenarioId = parsed.data?.scenarioId;
    const beatTimingOverridesMs = parsed.data?.beatTimingOverridesMs;
    const tokenBudgetOverride = parsed.data?.tokenBudgetOverride;

    // ── P5.1: difficulty routing — AT CREATION ONLY ─────────────────────────
    // A banded link routes the canonical scenario to its family sibling in the
    // requested band BEFORE the sandbox exists. The session then runs the
    // routed scenario end-to-end (curveball banding in sandbox.ts keys off
    // that scenario's own difficulty). effectiveBand — the routed scenario's
    // difficulty — is stamped once on the sessions INSERT and never updated:
    // running sessions are never re-routed.
    let effectiveScenarioId = scenarioId;
    let effectiveBand: DifficultyBand | undefined;
    if (linkBand && scenarioId) {
      const routing = await resolveScenarioForBand(scenarioId, linkBand);
      effectiveScenarioId = routing.scenarioId;
      effectiveBand = routing.effectiveBand ?? undefined;
      if (!routing.routed) {
        // Never fail the session over a routing miss — run the original.
        request.log.warn(
          { scenarioId, requestedBand: linkBand, effectiveBand: routing.effectiveBand },
          "difficulty routing found no family sibling for the requested band — starting the original scenario",
        );
      }
    }

    const sessionId = randomUUID();
    try {
      await createSandbox(
        sessionId,
        effectiveScenarioId,
        beatTimingOverridesMs,
        tokenBudgetOverride,
        sessionOrgId,
        effectiveBand,
      );
    } catch (err) {
      if (err instanceof DatasetUnavailableError) {
        // Scenario row exists but its dataset isn't deployed on this server —
        // a config/deploy mismatch, not a candidate error. Clean 422 instead
        // of a raw 500 leaking the server path.
        request.log.error({ err, scenarioId, effectiveScenarioId }, "scenario dataset unavailable");
        return reply.status(422).send({
          error: "This assessment is temporarily unavailable. Please pick another or try again later.",
        });
      }
      // Any other provisioning failure (e.g. the LiteLLM gateway rejecting
      // /key/generate) must NOT surface its raw message to the browser — that
      // text can carry internal gateway/error topology. Log the detail
      // server-side; return a generic 503. (Security audit 2026-07-10.)
      request.log.error({ err, scenarioId, effectiveScenarioId }, "sandbox provisioning failed");
      return reply.status(503).send({
        error: "Could not start the assessment right now. Please try again in a moment.",
      });
    }
    // RD6: atomically consume the link + bind it to this session. This is the
    // real single-use guard — if a concurrent start already consumed it we lose
    // the race here; tear the sandbox back down and 409 rather than leak a
    // second session off one link.
    if (linkToken) {
      try {
        await consumeSessionLink(linkToken, sessionId);
      } catch (err) {
        await destroySandbox(sessionId).catch(() => {});
        if (err instanceof SessionLinkError) {
          return reply.status(err.code === "invalid" ? 401 : 409).send({
            error: `session_link_${err.code}`,
            message: err.message,
          });
        }
        throw err;
      }
    }

    // Geo/network slice: first network observation for this session — appends
    // the one-time integrity.geo marker (system-authored, derived values only;
    // the raw IP is never persisted). AFTER createSandbox so the session row
    // exists. Fire-and-forget: it never throws and never delays the 201.
    void recordNetworkObservation(sessionId, request.ip, "session_create");

    const entry = sessionRegistry.get(sessionId)!;
    // Mint a session-bound JWT. The token is the ONLY thing that lets the
    // candidate use the protected routes — a leaked session UUID alone can
    // no longer drive chat / SQL / personas.
    const token = signToken(sessionId, entry.deadline.getTime());
    return reply.status(201).send({
      sessionId,
      deadline: entry.deadline.toISOString(),
      scenarioId: entry.scenarioId,
      token,
    });
  });

  // GET /sessions/:id — session metadata including live budget/status for the HUD.
  server.get<{ Params: { id: string } }>("/:id", {
    preHandler: [requireSessionToken((req) => (req.params as { id?: string }).id)],
  }, async (request, reply) => {
    const entry = await getOrRehydrateSession(request.params.id);
    if (!entry) return reply.status(404).send({ error: "Session not found" });
    const hasScenario = entry.scenarioId !== null;
    const initial = (entry.scenarioState["budget_initial"] ??
      {}) as Record<string, unknown>;
    return {
      sessionId: request.params.id,
      sandboxId: entry.sandboxId,
      createdAt: entry.createdAt.toISOString(),
      deadline: entry.deadline.toISOString(),
      budget: env.SESSION_BUDGET_USD,
      spend: entry.spendTally,
      status: entry.status,
      // null when this session has no scenario (legacy mode); otherwise the
      // live game-mechanic token balance the AI assistant draws from.
      scenarioTokensRemaining: hasScenario
        ? ((entry.scenarioState["tokens"] as number | undefined) ?? null)
        : null,
      // Static constraint snapshot — what the candidate started with. The HUD
      // uses these as the denominator in "X / Y" displays.
      scenarioConstraints: hasScenario
        ? {
            time_minutes:    (initial["time_minutes"]    as number | undefined) ?? null,
            tokens:          (initial["tokens"]          as number | undefined) ?? null,
            compute_minutes: (initial["compute_minutes"] as number | undefined) ?? null,
            money_usd:       (initial["money_usd"]       as number | undefined) ?? null,
            memory_mb:       (initial["memory_mb"]       as number | undefined) ?? null,
          }
        : null,
      // Live values for the hard-resource HUD indicators.
      scenarioBalances: hasScenario
        ? {
            tokens:          (entry.scenarioState["tokens"]          as number | undefined) ?? null,
            compute_minutes: (entry.scenarioState["compute_minutes"] as number | undefined) ?? null,
          }
        : null,
      // Latest deliverable mirrored from scenario_state.deliverable. The
      // POST /api/sessions/:id/deliverable route owns writes.
      deliverable: (entry.scenarioState["deliverable"] ?? null) as Record<string, unknown> | null,
      // Presentation metadata for the candidate UI (frozen at session
      // creation; see services/sandbox.ts scenarioMeta wiring).
      scenarioTitle:      entry.scenarioMeta?.title      ?? null,
      scenarioBrief:      entry.scenarioMeta?.brief      ?? null,
      scenarioRole:       entry.scenarioMeta?.role       ?? null,
      scenarioDifficulty: entry.scenarioMeta?.difficulty ?? null,
      // Persona name+role for the MESSAGES panel channel header. Null when the
      // scenario lacks the field (older sessions) → web falls back to legacy
      // hardcoded labels.
      clientPersona:      entry.scenarioMeta?.clientPersona ?? null,
      teamPersona:        entry.scenarioMeta?.teamPersona   ?? null,
    };
  });

  // DELETE /sessions/:id — manual end: clear timer + run shared teardown.
  server.delete<{ Params: { id: string } }>("/:id", {
    preHandler: [requireSessionToken((req) => (req.params as { id?: string }).id)],
  }, async (request, reply) => {
    await destroySandbox(request.params.id);
    return reply.status(204).send();
  });
}
