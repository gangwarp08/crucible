// family2-content.ts — hand-authored playthrough content for the DORMANT
// second scenario family (P3.4 calibration).
//
// Family:  fde-api-integration  (API-integration debugging — auth, pagination,
//          retries, contract drift), seeded dormant by migration 0023
//          (catalog_visible = false). Signed-off design:
//   - canonical (mid):      fde-api-integration
//   - same-band isomorph:   fde-api-integration-iso   (isomorph_of = canonical)
//   - hard pro variant:     fde-api-integration-pro
//   - native product-sense fork: the teammate proposes HARDCODING a workaround
//     that ships faster but silently breaks edge-case users. Measures Product
//     Sense ONLY (graded 5/3/1) via the shared model's product-sense
//     competency binding — design_under_constraints (the same key the
//     fde-db-triage fork feeds; see psForkDetectors in evidence-extractor.ts).
//     The decision is observable in the DELIVERABLE (Stage-A evidence).
//
// ── CONTENT CONTRACT with P3.1 (encode/seed) ────────────────────────────────
// These scripts are the calibration gates for content that is authored in the
// P3.1 slice. They assume:
//
//   1. Fixture layout mirrors family 1:
//        fixtures/fde-api-integration/{schema.sql, seed.sql, ground_truth.json}
//        fixtures/fde-api-integration-iso/{...}
//      with scenarios.dataset_ref = "fixtures/<slug>".
//
//   2. ground_truth.json carries AT LEAST the keys in Family2GroundTruth
//      below (extra keys welcome).
//
//   3. Dataset tables (queried by the playthroughs):
//        api_requests(id, endpoint, method, status_code, cursor, next_cursor,
//                     retry_of, requested_at)
//        provider_contacts(external_id, name, email, updated_at)   -- provider export
//        local_contacts(id, external_id, name, email, updated_at)  -- our synced copy
//
//   4. deliverable_spec.components has 4 components whose EXPECTED keys are
//      DELIVERABLE_KEYS below. If P3.1 names them differently the harness maps
//      the authored blocks onto the actual keys BY POSITION and warns.
//
//   5. The fork curveball's `tests` array includes "product_sense" (family-1
//      precedent: the shortcut_suggestion curveball) so the harness can find
//      it without hardcoding its id. Fallback: id matching
//      /shortcut|hardcode|workaround/ — which covers the P3.2 detector
//      default "hardcode_workaround" (psForkApiIntegrationDetectors in
//      evidence-extractor.ts; overridable via ground_truth.ps_fork.curveball_id).
//
// If the contract drifts, verify-family2-discrimination / -isomorph fail with
// an actionable message — fix the content or this module, never both silently.

export const FAMILY2 = {
  familyId: "fde-api-integration",
  canonicalSlug: "fde-api-integration",
  isoSlug: "fde-api-integration-iso",
  proSlug: "fde-api-integration-pro",
  /** The shared-model competency the product-sense fork feeds (same binding
   *  pattern as fde-db-triage's fork — never teamwork). */
  productSenseCompetency: "design_under_constraints",
} as const;

/** The 8 canonical competencies every family binds (model_version 1). */
export const CANONICAL_COMPETENCIES = [
  "problem_framing",
  "data_fluency",
  "design_under_constraints",
  "execution",
  "ai_orchestration",
  "teamwork",
  "customer_engagement",
  "outcome_communication",
] as const;

/** Minimum ground-truth contract for the family-2 fixtures. */
export interface Family2GroundTruth {
  /** Records the provider actually holds (source of truth). */
  provider_record_count: number;
  /** Records our local sync ended up with. */
  synced_record_count: number;
  /** The gap the candidate must quantify (provider − distinct local). */
  missing_record_count: number;
  /** Records the hardcoded workaround would silently drop/corrupt
   *  (the edge-case users the fork trades away). */
  edge_case_record_count: number;
  /** Machine-readable root cause, e.g. "cursor_pagination_contract_drift". */
  root_cause: string;
}

export const REQUIRED_GT_KEYS: ReadonlyArray<keyof Family2GroundTruth> = [
  "provider_record_count",
  "synced_record_count",
  "missing_record_count",
  "edge_case_record_count",
  "root_cause",
];

export function assertGroundTruth(
  gt: Record<string, unknown>,
  label: string,
): asserts gt is Record<string, unknown> & Family2GroundTruth {
  const missing = REQUIRED_GT_KEYS.filter((k) =>
    k === "root_cause" ? typeof gt[k] !== "string" : typeof gt[k] !== "number",
  );
  if (missing.length > 0) {
    throw new Error(
      `${label}: ground_truth.json violates the family-2 content contract — ` +
        `missing/mistyped keys: ${missing.join(", ")} ` +
        `(see CONTENT CONTRACT in scripts/family2-content.ts)`,
    );
  }
}

/** Expected deliverable component keys, in order (mapped by position when the
 *  seeded spec differs, with a warning). */
export const DELIVERABLE_KEYS = [
  "reconciled_sync_report",
  "root_cause_finding",
  "client_facing_summary",
  "decisions_and_tradeoffs",
] as const;

// ── SQL (strong run) ─────────────────────────────────────────────────────────

/** [1] HTTP status distribution — surfaces the 401/429 red herring so it can
 *  be quantified and rejected. */
export const SQL_STATUS_DISTRIBUTION = `
  SELECT status_code, COUNT(*) AS n
  FROM api_requests
  GROUP BY status_code
  ORDER BY n DESC
`.trim();

/** [2] The gap: provider count vs distinct local count. */
export const SQL_RECORD_GAP = `
  SELECT
    (SELECT COUNT(*) FROM provider_contacts) AS provider_n,
    (SELECT COUNT(DISTINCT external_id) FROM local_contacts) AS local_n,
    (SELECT COUNT(*) FROM provider_contacts)
      - (SELECT COUNT(DISTINCT external_id) FROM local_contacts) AS missing_n
`.trim();

/** [3] Characterize the missing records (they cluster at cursor-page
 *  boundaries — the contract-drift fingerprint). */
export const SQL_MISSING_RECORDS = `
  SELECT p.external_id, p.updated_at
  FROM provider_contacts p
  LEFT JOIN local_contacts l ON l.external_id = p.external_id
  WHERE l.external_id IS NULL
  ORDER BY p.updated_at
  LIMIT 25
`.trim();

/** [4] Pagination fingerprint: retried requests re-using a stale cursor, so a
 *  page is fetched twice and its successor skipped. */
export const SQL_CURSOR_FINGERPRINT = `
  SELECT cursor, COUNT(*) AS n
  FROM api_requests
  WHERE endpoint LIKE '%/contacts%' AND status_code = 200
  GROUP BY cursor
  HAVING COUNT(*) > 1
  ORDER BY n DESC
  LIMIT 10
`.trim();

/** [5] Retry paths (which requests were retries, of what). */
export const SQL_RETRY_FINGERPRINT = `
  SELECT retry_of, COUNT(*) AS n
  FROM api_requests
  WHERE retry_of IS NOT NULL
  GROUP BY retry_of
  ORDER BY n DESC
  LIMIT 10
`.trim();

/** Weak run: one shallow count, nothing else. */
export const SQL_WEAK_NAIVE_COUNT = `SELECT COUNT(*) AS n FROM local_contacts`.trim();

// ── Messages ─────────────────────────────────────────────────────────────────

export const MSG_STRONG_CLARIFY_CLIENT =
  "Before I dig in — which integration is dropping records, roughly how many do you " +
  "believe are missing, and since when? And is the provider export you have the full " +
  "source of truth? Want to make sure I reconcile the right window.";

export const MSG_STRONG_TEAM_PUSHBACK =
  "Checked the auth theory — the 401s are a handful of requests and every one of them " +
  "was retried successfully, so expiring tokens don't explain the gap. The missing " +
  "records cluster exactly at page boundaries: the provider's /contacts endpoint moved " +
  "from offset to cursor pagination, and our retry path re-sends a stale cursor, so we " +
  "re-fetch one page and silently skip its successor. That's contract drift plus a " +
  "non-idempotent retry, not auth. Does the client SDK pin an API version anywhere?";

export const MSG_STRONG_FORK_DECLINE =
  "I hear the deadline, but we can't ship the hardcoded workaround — it silently drops " +
  "the boundary-page records, which is exactly the set of users already hurt by the bug. " +
  "They'd never sync again and nobody would notice until a customer complains. Honoring " +
  "next_cursor on retry is a small change; I'll do it properly and backfill the missing " +
  "records, it's quick.";

export const MSG_WEAK_CLIENT_VAGUE = "hey, the sync thing is broken?";

export const MSG_WEAK_TEAM_ACK = "ok yeah, expiring tokens sounds right — i'll refresh them";

export const MSG_WEAK_FORK_ACCEPT =
  "yeah good call — the hardcoded workaround gets us shipping today, let's just do that. " +
  "i'll pin the page size and skip the cursor handling.";

export const AI_STRONG_PROMPT =
  "One sentence: when a REST API switches from offset to cursor pagination, what's the " +
  "correct way to make a retried page request idempotent so records at the page boundary " +
  "aren't skipped?";

// ── Deliverables ─────────────────────────────────────────────────────────────

const fmtN = (n: number): string => n.toLocaleString("en-US");

/** STRONG deliverable — proper fix, correct counts from THIS scenario's ground
 *  truth, fork declined and the decision stated (observable in the
 *  deliverable, per the signed-off fork design). Returned in DELIVERABLE_KEYS
 *  order. */
export function strongDeliverable(gt: Family2GroundTruth): string[] {
  return [
    // reconciled_sync_report
    `${SQL_RECORD_GAP};\n\n` +
      `Provider holds ${fmtN(gt.provider_record_count)} contact records; our local sync has ` +
      `${fmtN(gt.synced_record_count)} distinct records — ${fmtN(gt.missing_record_count)} records ` +
      `are missing, and they cluster at cursor-page boundaries (see the LEFT JOIN + cursor ` +
      `fingerprint queries). After the pagination fix + backfill, local count reconciles to ` +
      `${fmtN(gt.provider_record_count)}.`,
    // root_cause_finding
    `Contract drift in the provider's /contacts endpoint: it moved from offset to cursor ` +
      `pagination, and our retry path re-sends a stale cursor — the retried page is fetched ` +
      `twice and its successor page silently skipped, dropping ${fmtN(gt.missing_record_count)} ` +
      `records. Verified by the duplicate-cursor fingerprint (GROUP BY cursor HAVING COUNT(*)>1) ` +
      `and by the missing records lining up with skipped pages. The auth/token-expiry theory was ` +
      `tested and rejected: every 401 was retried successfully, so it cannot account for the gap.`,
    // client_facing_summary
    `About ${fmtN(gt.missing_record_count)} of your contacts stopped syncing after your provider ` +
      `changed how its API pages through records. No data was lost on the provider side — our ` +
      `sync was skipping a page whenever a request had to be retried. We've fixed the sync to ` +
      `follow the provider's new paging correctly and backfilled the missing contacts; the ` +
      `reconciled count now matches the provider exactly (${fmtN(gt.provider_record_count)} records).`,
    // decisions_and_tradeoffs
    `Declined the proposed hardcoded workaround (pinning the page size and skipping cursor ` +
      `handling): it ships faster but silently breaks the ${fmtN(gt.edge_case_record_count)} ` +
      `boundary-page records — exactly the users already affected. Implemented the real fix ` +
      `instead: honor next_cursor on retry (idempotent pagination) and backfill. Recommend ` +
      `pinning the provider API version and adding a contract test on the pagination shape so ` +
      `the next drift is caught in CI, plus a nightly provider-vs-local count reconciliation alarm.`,
  ];
}

/** WEAK deliverable — ships the hardcoded workaround (fork taken, stated in
 *  the deliverable), wrong cause (auth red herring), no quantification. */
export function weakDeliverable(gt: Family2GroundTruth): string[] {
  return [
    // reconciled_sync_report
    `${SQL_WEAK_NAIVE_COUNT};\n\nLocal table has ${fmtN(gt.synced_record_count)} rows, which ` +
      `looks close enough after the workaround. Didn't reconcile against the provider export.`,
    // root_cause_finding
    `Auth tokens were expiring mid-sync, which made some requests fail.`,
    // client_facing_summary
    `We patched the sync with a hardcoded fallback and refreshed the tokens, so the numbers ` +
      `should look right going forward.`,
    // decisions_and_tradeoffs
    `n/a — shipped the quick hardcoded workaround the team suggested to save time.`,
  ];
}

// ── Fork-beat discovery ──────────────────────────────────────────────────────

interface CurveballLike {
  id?: unknown;
  tests?: unknown;
}

/** Find the product-sense fork curveball id in a scenario's curveballs array
 *  (contract item 5). Returns null when absent. */
export function findForkCurveballId(curveballs: unknown[]): string | null {
  for (const c of curveballs) {
    if (!c || typeof c !== "object") continue;
    const cb = c as CurveballLike;
    const id = typeof cb.id === "string" ? cb.id : null;
    if (!id) continue;
    const tests = Array.isArray(cb.tests) ? cb.tests : [];
    if (tests.includes("product_sense")) return id;
    if (/shortcut|hardcode|workaround/i.test(id)) return id;
  }
  return null;
}

/** All curveball ids (to push non-fork beats past session end). */
export function allCurveballIds(curveballs: unknown[]): string[] {
  return curveballs
    .map((c) => (c && typeof c === "object" ? (c as CurveballLike).id : null))
    .filter((id): id is string => typeof id === "string");
}

// ── P3.1 authored-content contract (encode scripts + verify-family2-content) ─
//
// The scenario.json documents under fixtures/fde-api-integration{,-pro}/ are
// the family's source of truth: the encode-fde-api-integration*.ts scripts
// upsert them (the apply path without the Supabase CLI) and migration 0023 was
// generated from them. validateFamily2ScenarioDoc() is the single place the
// authored shape is checked, so encode, migration regeneration, and the
// content verifier cannot drift from each other.

/** The canonical fork curveball id — MUST match the P3.2 detector default
 *  (PS_FORK2_DEFAULT_CURVEBALL_ID in evidence-extractor.ts). */
export const FORK_CURVEBALL_ID = "hardcode_workaround";

/** The scenario_families registry row (0011 model) for family 2 — minus
 *  competency_targets, which mirror the CANONICAL member's rubric weights and
 *  are derived from scenario.json at encode/migration-generation time so the
 *  registry can never drift from the binding. */
export const FAMILY2_REGISTRY = {
  family_id: FAMILY2.familyId,
  title: "API-integration debugging (contact sync)",
  difficulty_band: "mid",
  radical_spec: {
    task:
      "Debug a third-party API integration that silently drops records: quantify the " +
      "provider-vs-local gap, find the root cause (cursor-pagination contract drift + a " +
      "non-idempotent retry), reject the auth red herring with evidence, fix and backfill, " +
      "and deliver a plain-English client summary.",
    bug_class: "cursor_pagination_contract_drift",
    failure_mechanism: "non_idempotent_retry_stale_cursor",
    reconcile_key: "external_id",
    red_herrings: ["token_expiry_401", "rate_limit_429"],
    missing_cluster: "cursor_page_boundaries",
    ps_fork: {
      curveball_id: FORK_CURVEBALL_ID,
      shortcut: "pin_page_size_skip_cursor_handling",
      measures: FAMILY2.productSenseCompetency,
      grading: [5, 3, 1],
    },
    deliverable_components: 4,
  },
} as const;

export interface Family2ScenarioDoc {
  slug: string;
  title?: string;
  role?: string;
  difficulty: string;
  dataset_ref: string;
  family_id?: string;
  isomorph_of?: string | null;
  brief: string;
  docs: Array<{ id: string; title: string; body: string }>;
  client_persona: Record<string, unknown>;
  team_persona: Record<string, unknown>;
  constraints: Record<string, number>;
  curveballs: Array<Record<string, unknown>>;
  deliverable_spec: { components: Array<{ key: string } & Record<string, unknown>> };
  rubric: Array<
    { competency_key: string; weight: number; scenario_anchors?: Record<string, string> } &
    Record<string, unknown>
  >;
  success_criteria: Record<string, unknown>;
  radical_values: Record<string, unknown>;
  incidental_values: Record<string, unknown>;
}

/** Validate one authored family-2 scenario document against the P3 contract.
 *  Returns a list of violations (empty = valid) so callers can report all
 *  problems at once instead of failing on the first. */
export function validateFamily2ScenarioDoc(
  doc: Family2ScenarioDoc,
  expected: { slug: string; difficulty: string; isomorphOf: string | null },
): string[] {
  const bad: string[] = [];
  const label = expected.slug;

  if (doc.slug !== expected.slug) bad.push(`${label}: slug is '${doc.slug}'`);
  if (doc.difficulty !== expected.difficulty) {
    bad.push(`${label}: difficulty '${doc.difficulty}' ≠ expected band '${expected.difficulty}'`);
  }
  if (doc.family_id !== FAMILY2.familyId) {
    bad.push(`${label}: family_id '${doc.family_id}' ≠ '${FAMILY2.familyId}'`);
  }
  if ((doc.isomorph_of ?? null) !== expected.isomorphOf) {
    bad.push(`${label}: isomorph_of '${doc.isomorph_of}' ≠ expected '${expected.isomorphOf}'`);
  }
  if (doc.dataset_ref !== `fixtures/${expected.slug}`) {
    bad.push(`${label}: dataset_ref '${doc.dataset_ref}' ≠ 'fixtures/${expected.slug}'`);
  }
  if (typeof doc.brief !== "string" || doc.brief.length < 200) {
    bad.push(`${label}: brief missing or too short to be authored content`);
  }
  if (!Array.isArray(doc.docs) || doc.docs.length === 0) bad.push(`${label}: no docs authored`);

  // Rubric: a BINDING ARRAY over exactly the 8 canonical competencies,
  // weights summing to 1.00 (integer cents to dodge float drift).
  const keys = (doc.rubric ?? []).map((r) => r.competency_key).sort().join(",");
  const canonical = [...CANONICAL_COMPETENCIES].sort().join(",");
  if (keys !== canonical) bad.push(`${label}: rubric keys [${keys}] ≠ the 8 canonical competencies`);
  const cents = (doc.rubric ?? []).reduce((s, r) => s + Math.round((r.weight ?? 0) * 100), 0);
  if (cents !== 100) bad.push(`${label}: rubric weights sum to ${cents / 100}, expected 1.00`);

  // Native product-sense fork: present, team channel, product_sense-tagged,
  // family-1 fork JSON shape (trigger.time_offset_minutes + payload.message),
  // and the id the P3.2 detectors expect by default.
  const forkId = findForkCurveballId(doc.curveballs ?? []);
  if (!forkId) bad.push(`${label}: no product-sense fork curveball found`);
  else if (forkId !== FORK_CURVEBALL_ID) {
    bad.push(`${label}: fork curveball id '${forkId}' ≠ detector default '${FORK_CURVEBALL_ID}'`);
  }
  const fork = (doc.curveballs ?? []).find((c) => c["id"] === FORK_CURVEBALL_ID);
  if (fork) {
    const trigger = (fork["trigger"] ?? {}) as Record<string, unknown>;
    const payload = (fork["payload"] ?? {}) as Record<string, unknown>;
    const tests = Array.isArray(fork["tests"]) ? (fork["tests"] as unknown[]) : [];
    if (typeof trigger["time_offset_minutes"] !== "number") {
      bad.push(`${label}: fork trigger.time_offset_minutes missing (family-1 fork shape)`);
    }
    if (payload["channel"] !== "team") bad.push(`${label}: fork payload.channel ≠ 'team'`);
    if (typeof payload["message"] !== "string" || !/hardcode|workaround|pin|skip/i.test(payload["message"] as string)) {
      bad.push(`${label}: fork payload.message doesn't pitch the hardcode workaround`);
    }
    if (!tests.includes("product_sense")) bad.push(`${label}: fork tests[] missing 'product_sense'`);
  }

  // Fork grading lives on the product-sense competency: 5/3/1 scenario_anchors
  // referencing the hardcode decision. Teamwork carries NO scenario_anchors —
  // the fork must not leak into the session-wide teamwork signal.
  const ps = (doc.rubric ?? []).find((r) => r.competency_key === FAMILY2.productSenseCompetency);
  const anchors = ps?.scenario_anchors;
  if (!anchors) bad.push(`${label}: ${FAMILY2.productSenseCompetency} has no scenario_anchors (fork ungraded)`);
  else {
    if (!["5", "3", "1"].every((b) => typeof anchors[b] === "string" && anchors[b]!.length > 0)) {
      bad.push(`${label}: fork anchors missing one of bands 5/3/1`);
    }
    if (!Object.keys(anchors).every((b) => /^[1-5]$/.test(b))) {
      bad.push(`${label}: fork anchor bands off the 1–5 scale: ${Object.keys(anchors).join(",")}`);
    }
    if (!/hardcode|workaround|shortcut|edge.?case/i.test(JSON.stringify(anchors))) {
      bad.push(`${label}: fork anchors don't reference the hardcode/workaround decision`);
    }
  }
  const tw = (doc.rubric ?? []).find((r) => r.competency_key === "teamwork");
  if (tw?.scenario_anchors) bad.push(`${label}: teamwork carries scenario_anchors — fork leakage`);

  // Deliverable components: the four keys the harness maps onto (order-exact).
  const specKeys = (doc.deliverable_spec?.components ?? []).map((c) => c.key);
  if (JSON.stringify(specKeys) !== JSON.stringify([...DELIVERABLE_KEYS])) {
    bad.push(`${label}: deliverable keys [${specKeys.join(",")}] ≠ contract [${DELIVERABLE_KEYS.join(",")}]`);
  }

  // Radical/incidental declarations present (0011 family model).
  if (Object.keys(doc.radical_values ?? {}).length === 0) bad.push(`${label}: radical_values empty`);
  if (Object.keys(doc.incidental_values ?? {}).length === 0) bad.push(`${label}: incidental_values empty`);

  return bad;
}

/** Derive the ISOMORPH document from the canonical one — same authored content
 *  verbatim, only the incidentals swapped (slug/title/dataset_ref/seed link).
 *  Used by BOTH encode-fde-api-integration-iso.ts and the migration
 *  regeneration so the two paths cannot diverge. */
export function deriveIsoScenarioDoc(canonical: Family2ScenarioDoc): Family2ScenarioDoc {
  return {
    ...canonical,
    slug: FAMILY2.isoSlug,
    title: "Contact sync triage (isomorph B)",
    dataset_ref: `fixtures/${FAMILY2.isoSlug}`,
    isomorph_of: FAMILY2.canonicalSlug,
    // radical_values REUSED verbatim (that is what makes it an isomorph);
    // incidentals point at the iso seed (different counts/page size).
    incidental_values: {
      ...canonical.incidental_values,
      seed_label: "fde-api-integration-iso-v1",
      page_size: 50,
    },
  };
}
