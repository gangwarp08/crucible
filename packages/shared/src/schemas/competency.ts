import { z } from "zod";

/**
 * L0 — Canonical competency model (Slice 5.1).
 *
 * Splits the construct (what we measure — identical across every scenario) from
 * the binding (how one scenario surfaces evidence for it). Before 5.1 the two
 * were conflated inside `scenarios.rubric`, which made cross-scenario
 * comparison impossible. Now:
 *   - `competencies` rows = the canonical, versioned construct.
 *   - `scenarios.rubric` = a RubricBinding array referencing canonical keys,
 *     carrying per-scenario weights and optional overrides.
 *   - Every evaluation records the competency_model_version it ran under.
 */

/** Per-band anchor text, keyed by score band ("1".."5"). Not every band need
 *  be present (the base scenario uses 1/3/5; pro uses 1..5). */
export const AnchorSetSchema = z.record(z.string(), z.string());
export type AnchorSet = z.infer<typeof AnchorSetSchema>;

/** One canonical competency at a given model version. definition / default_*
 *  are the construct-level defaults; a scenario binding may override them. */
export const CompetencySchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  construct_family: z.string().min(1),
  definition: z.string().min(1),
  default_signals: z.array(z.string()).default([]),
  default_anchors: AnchorSetSchema.default({}),
  /** Optional scoring caveat the judge honours (e.g. "process is process"). */
  default_scoring_note: z.string().nullish(),
  /** Reserved for future structured sub-skills; empty in v1. */
  dimensions: z.array(z.unknown()).default([]),
  version: z.number().int().positive(),
});
export type Competency = z.infer<typeof CompetencySchema>;

/** A frozen set of competency rows = one model version. */
export const CompetencyModelVersionSchema = z.object({
  version: z.number().int().positive(),
  frozen_at: z.string().nullish(),
  note: z.string().nullish(),
});
export type CompetencyModelVersion = z.infer<typeof CompetencyModelVersionSchema>;

/** One scenario's binding for a single competency. `weight` is required;
 *  anything `scenario_*` overrides the canonical default for THIS scenario. */
export const RubricBindingEntrySchema = z.object({
  competency_key: z.string().min(1),
  weight: z.number().min(0).max(1),
  /** Whether this competency is load-bearing for the scenario. Not every
   *  scenario need measure every competency. */
  load_bearing: z.boolean().default(true),
  scenario_anchors: AnchorSetSchema.optional(),
  scenario_description: z.string().optional(),
  scenario_signals: z.array(z.string()).optional(),
  scenario_scoring_note: z.string().optional(),
  /** Optional deterministic-extractor hints (used from Slice 5.2 onward). */
  evidence_hints: z.array(z.string()).optional(),
});
export type RubricBindingEntry = z.infer<typeof RubricBindingEntrySchema>;

/** The new shape of `scenarios.rubric`: an ordered binding array. */
export const RubricBindingSchema = z.array(RubricBindingEntrySchema);
export type RubricBinding = z.infer<typeof RubricBindingSchema>;

/** The effective per-competency rubric the judge consumes once a binding is
 *  resolved against the canonical model. Mirrors the pre-5.1 rubric item shape
 *  so the LLM input is unchanged (lossless rebind). */
export const ResolvedRubricItemSchema = z.object({
  weight: z.number(),
  description: z.string(),
  signals: z.array(z.string()),
  anchors: AnchorSetSchema,
  scoring_note: z.string().optional(),
});
export type ResolvedRubricItem = z.infer<typeof ResolvedRubricItemSchema>;
