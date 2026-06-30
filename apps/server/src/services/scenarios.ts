// Scenario catalog reader — server-only, service-role.
// The browser never reaches Supabase directly (CLAUDE.md Hard Rule §2).
import { supabase } from "./supabase.js";

export interface Scenario {
  id: string;
  slug: string;
  title: string;
  role: string;
  difficulty: string | null;
  brief: string | null;
  client_persona: Record<string, unknown>;
  team_persona: Record<string, unknown>;
  dataset_ref: string | null;
  docs: unknown[];
  constraints: Record<string, unknown>;
  rubric: Record<string, unknown>;
  deliverable_spec: Record<string, unknown>;
  curveballs: unknown[];
  success_criteria: Record<string, unknown>;
  created_at: string;
}

const COLUMNS =
  "id, slug, title, role, difficulty, brief, client_persona, team_persona, " +
  "dataset_ref, docs, constraints, rubric, deliverable_spec, curveballs, " +
  "success_criteria, created_at";

async function loadOne(
  column: "id" | "slug",
  value: string,
): Promise<Scenario | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("scenarios")
    .select(COLUMNS)
    .eq(column, value)
    .maybeSingle();
  if (error) {
    console.error(`[scenarios] load by ${column} failed`, error.message);
    return null;
  }
  // The supabase-js typed select() returns a parsed-string type, not our
  // domain shape — cast through unknown since the SELECT projection above
  // is what defines the runtime shape.
  return (data as unknown as Scenario) ?? null;
}

export function loadScenarioById(id: string): Promise<Scenario | null> {
  return loadOne("id", id);
}

export function loadScenarioBySlug(slug: string): Promise<Scenario | null> {
  return loadOne("slug", slug);
}

/** Catalog row — minimal metadata for the public scenarios list. Does NOT
 *  expose the brief, rubric, personas, or curveballs (those stay gated
 *  behind the per-scenario invite-coded route). */
export interface ScenarioCatalogRow {
  slug:       string;
  title:      string;
  role:       string;
  difficulty: string | null;
  created_at: string;
}

export async function listScenarios(): Promise<ScenarioCatalogRow[]> {
  if (!supabase) return [];
  // Exclude ISOMORPHS (isomorph_of IS NOT NULL): they are alternate forms of an
  // existing scenario used for measurement equivalence, not standalone catalog
  // entries — a candidate should never pick "isomorph B" directly (the system
  // assigns one). Canonical scenarios (incl. cross-band variants like -pro,
  // which have isomorph_of = null) still list.
  const { data, error } = await supabase
    .from("scenarios")
    .select("slug, title, role, difficulty, created_at")
    .is("isomorph_of", null)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[scenarios] list failed", error.message);
    return [];
  }
  return (data as unknown as ScenarioCatalogRow[]) ?? [];
}
