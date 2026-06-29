// L0 — Canonical competency model access (Slice 5.1).
//
// Loads the active competency model version and resolves a scenario's rubric
// BINDING (the new `scenarios.rubric` array shape) against the canonical
// competencies into the effective per-competency rubric the judge consumes.
//
// The resolution is lossless by construction: a binding entry overrides a
// canonical default only via its `scenario_*` fields, so a binding that omits
// them resolves back to the canonical values. For fde-db-triage this reproduces
// the pre-rebind rubric byte-for-byte (proven by verify-competency-model.ts).
//
// Reads strictly from Supabase (service-role) — no in-memory dependency, so it
// works for the post-session analysis + the historical re-evaluate path.

import { supabase } from "./supabase.js";
import {
  RubricBindingSchema,
  type Competency,
  type ResolvedRubricItem,
} from "@crucible/shared";

/** Canonical model at one version: competency-key → canonical competency. */
export interface ResolvedModel {
  version: number;
  competencies: Map<string, Competency>;
}

/** Effective rubric the judge sees: competency-key → resolved item, in the
 *  binding's declared order (preserved by the `keys` array). */
export interface ResolvedRubric {
  rubric: Record<string, ResolvedRubricItem>;
  keys: string[];
}

export class CompetencyModelError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "CompetencyModelError";
  }
}

/** Highest (newest) competency model version. v1 has exactly one; this is the
 *  seam for future versions — the active model is always the latest frozen one. */
export async function loadActiveModelVersion(): Promise<number> {
  if (!supabase) {
    throw new CompetencyModelError("Supabase client unavailable; cannot load competency model");
  }
  const { data, error } = await supabase
    .from("competency_model_versions")
    .select("version")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new CompetencyModelError(`model-version read failed: ${error.message}`);
  }
  if (!data) {
    throw new CompetencyModelError(
      "no competency_model_versions row — apply migrations 0007/0008",
    );
  }
  return (data as { version: number }).version;
}

interface CompetencyRow {
  key: string;
  name: string;
  construct_family: string;
  definition: string;
  default_signals: string[] | null;
  default_anchors: Record<string, string> | null;
  default_scoring_note: string | null;
  dimensions: unknown[] | null;
  model_version: number;
}

/** Load every canonical competency for a model version. */
export async function loadModel(version: number): Promise<ResolvedModel> {
  if (!supabase) {
    throw new CompetencyModelError("Supabase client unavailable; cannot load competency model");
  }
  const { data, error } = await supabase
    .from("competencies")
    .select(
      "key, name, construct_family, definition, default_signals, default_anchors, " +
        "default_scoring_note, dimensions, model_version",
    )
    .eq("model_version", version);
  if (error) {
    throw new CompetencyModelError(`competencies read failed: ${error.message}`);
  }
  const rows = (data ?? []) as unknown as CompetencyRow[];
  if (rows.length === 0) {
    throw new CompetencyModelError(`competency model v${version} has no rows`);
  }
  const competencies = new Map<string, Competency>();
  for (const r of rows) {
    competencies.set(r.key, {
      key: r.key,
      name: r.name,
      construct_family: r.construct_family,
      definition: r.definition,
      default_signals: r.default_signals ?? [],
      default_anchors: r.default_anchors ?? {},
      default_scoring_note: r.default_scoring_note ?? null,
      dimensions: r.dimensions ?? [],
      version: r.model_version,
    });
  }
  return { version, competencies };
}

/**
 * Resolve a scenario's rubric binding against the canonical model into the
 * effective rubric the judge consumes. Throws if the binding references a
 * competency absent from the model (a rebind/authoring error we want loud).
 */
export function resolveBinding(rawRubric: unknown, model: ResolvedModel): ResolvedRubric {
  const binding = RubricBindingSchema.parse(rawRubric);
  const rubric: Record<string, ResolvedRubricItem> = {};
  const keys: string[] = [];
  for (const entry of binding) {
    const canonical = model.competencies.get(entry.competency_key);
    if (!canonical) {
      throw new CompetencyModelError(
        `scenario rubric references unknown competency '${entry.competency_key}' ` +
          `(competency model v${model.version})`,
      );
    }
    const item: ResolvedRubricItem = {
      weight: entry.weight,
      description: entry.scenario_description ?? canonical.definition,
      signals: entry.scenario_signals ?? canonical.default_signals,
      anchors: entry.scenario_anchors ?? canonical.default_anchors,
    };
    const note = entry.scenario_scoring_note ?? canonical.default_scoring_note ?? undefined;
    if (note) item.scoring_note = note;
    rubric[entry.competency_key] = item;
    keys.push(entry.competency_key);
  }
  return { rubric, keys };
}

/** Convenience: load the active model and resolve a binding in one call. */
export async function resolveScenarioRubric(rawRubric: unknown): Promise<{
  version: number;
  resolved: ResolvedRubric;
}> {
  const version = await loadActiveModelVersion();
  const model = await loadModel(version);
  return { version, resolved: resolveBinding(rawRubric, model) };
}
