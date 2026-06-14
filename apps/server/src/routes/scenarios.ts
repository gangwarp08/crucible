// Candidate-facing scenario lookup.
//
// GET /api/scenarios/:slug — returns the subset of a scenario row that's
// safe to expose to a candidate BEFORE they start the assessment, so the
// /start/[slug] landing page can render brief + constraints + the names
// of the deliverable components.
//
// Deliberately omitted from the response (these would leak hints):
//   rubric, success_criteria, deliverable_spec.accept_criteria,
//   client_persona, team_persona, curveballs, dataset_ref.

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { loadScenarioBySlug, listScenarios } from "../services/scenarios.js";
import { env } from "../env.js";

const ParamsSchema = z.object({ slug: z.string().min(1).max(120) });

interface DeliverableComponent {
  key: string;
  label: string;
  what: string;
}

export async function scenariosRoutes(server: FastifyInstance) {
  // GET /api/scenarios — catalog list.
  //
  // Public on purpose: the candidate-facing catalog page needs to render
  // titles/roles/difficulty without the invite code (the invite-gated
  // detail route /api/scenarios/:slug carries the actual IP — brief,
  // constraints, deliverable shape — and stays behind the gate).
  server.get("/", async (_request, reply) => {
    const rows = await listScenarios();
    return reply.send({ scenarios: rows });
  });

  server.get<{ Params: { slug: string } }>("/:slug", async (request, reply) => {
    const parsed = ParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid slug" });
    }

    // Invite-code gate. Same shared-secret pattern as POST /sessions so
    // competitors can't dump the brief / constraints / deliverable shape
    // by hitting the URL directly. Gate is off when env.INVITE_CODE is
    // unset (local dev / preview) — backward-compatible.
    if (env.INVITE_CODE) {
      const provided = request.headers["x-invite-code"];
      const code = Array.isArray(provided) ? provided[0] : provided;
      if (code !== env.INVITE_CODE) {
        return reply.status(401).send({
          error: "invite_required",
          message: "This assessment requires an invite code.",
        });
      }
    }

    const scenario = await loadScenarioBySlug(parsed.data.slug);
    if (!scenario) {
      return reply.status(404).send({ error: "Scenario not found" });
    }

    const constraints = (scenario.constraints ?? {}) as Record<string, unknown>;
    const spec = (scenario.deliverable_spec ?? {}) as { components?: unknown };
    const rawComponents = Array.isArray(spec.components) ? spec.components : [];
    const components: DeliverableComponent[] = rawComponents
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
      .map((c) => ({
        key:   typeof c["key"]   === "string" ? (c["key"]   as string) : "",
        label: typeof c["label"] === "string" ? (c["label"] as string) : "",
        what:  typeof c["what"]  === "string" ? (c["what"]  as string) : "",
      }));

    return reply.send({
      id:         scenario.id,
      slug:       scenario.slug,
      title:      scenario.title,
      role:       scenario.role,
      difficulty: scenario.difficulty,
      brief:      scenario.brief,
      constraints: {
        time_minutes:    (constraints["time_minutes"]    as number | undefined) ?? null,
        tokens:          (constraints["tokens"]          as number | undefined) ?? null,
        compute_minutes: (constraints["compute_minutes"] as number | undefined) ?? null,
        money_usd:       (constraints["money_usd"]       as number | undefined) ?? null,
        memory_mb:       (constraints["memory_mb"]       as number | undefined) ?? null,
      },
      deliverable_components: components,
    });
  });
}
