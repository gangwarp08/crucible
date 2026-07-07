// Acceptance verifier for P5.1 — difficulty routing at session creation.
// Infra-light: no server, no E2B, no LLM. Seeds a synthetic scenario family
// (mid canonical + hard sibling + a mid ISOMORPH that must never be a routing
// target) directly via the service-role client and asserts:
//   - band → family-sibling resolution (mid scenario + band 'hard' → the hard
//     sibling, routed:true; same band → itself, routed:true)
//   - isomorphs (isomorph_of IS NOT NULL) are never selected as routing targets
//   - fallback when the family has no member in the requested band: the
//     ORIGINAL scenario comes back with routed:false (routing never fails a
//     session)
//   - link band persistence: createSessionLink({ difficultyBand }) stores the
//     band on the session_links row and surfaces it on the summary
//     (gracefully SKIPPED when migration 0022 isn't applied)
//   - effective-band stamping logic at the pure-function level:
//     effectiveBandForStamp + BandRouting.effectiveBand — the value stamped on
//     sessions.difficulty_band is the ROUTED scenario's own difficulty
//   - IMMUTABILITY: no exported routing/equating/link function mutates an
//     existing session's difficulty_band (runtime probe over a seeded session
//     row + a static source scan for update payloads carrying the column)
// Self-cleans. Exit 0 on PASS, 1 on FAIL.
//
// Run: pnpm --filter @crucible/server exec tsx scripts/verify-difficulty-routing.ts
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, resolve, join } from "path";
import { readFileSync, readdirSync, statSync } from "fs";
import { WebSocket } from "undici";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const SUPABASE_URL =
  process.env.SUPABASE_URL ??
  (process.env.SUPABASE_PROJECT_REF ? `https://${process.env.SUPABASE_PROJECT_REF}.supabase.co` : null);
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("Missing SUPABASE env"); process.exit(1); }

// Import AFTER dotenv so the service modules pick up env at load.
const routing = await import("../src/services/difficulty-routing.js");
const links = await import("../src/services/session-link.js");
const equating = await import("../src/services/equating.js");

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  realtime: { transport: WebSocket as any },
});

let failures = 0;
const fail = (m: string) => { failures++; console.error("  FAIL:", m); };
const pass = (m: string) => console.log("  PASS:", m);
const check = (name: string, ok: boolean, detail?: string) =>
  ok ? pass(name) : fail(`${name}${detail ? ` — ${detail}` : ""}`);

// Fixed synthetic ids (self-cleaning; d5 51 prefix = difficulty-routing verifier).
const FAMILY = "verify-difficulty-routing-family";
const MID  = "00000000-0000-4000-8000-0000000d5101"; // canonical mid member
const HARD = "00000000-0000-4000-8000-0000000d5102"; // canonical hard member
const ISO  = "00000000-0000-4000-8000-0000000d5103"; // mid ISOMORPH (never a target)
const LONE = "00000000-0000-4000-8000-0000000d5104"; // family-less scenario
const SESS = "00000000-0000-4000-8000-0000000d5105"; // immutability probe session

async function cleanup(): Promise<void> {
  await supabase.from("session_links").delete().like("candidate_label", "verify-difficulty-routing%");
  await supabase.from("sessions").delete().eq("id", SESS);
  await supabase.from("scenarios").delete().in("id", [MID, HARD, ISO, LONE]);
  await supabase.from("scenario_families").delete().eq("family_id", FAMILY);
}

async function seed(): Promise<void> {
  const { error: famErr } = await supabase.from("scenario_families").insert({
    family_id: FAMILY, title: "verify difficulty routing (synthetic)", difficulty_band: "mid",
  });
  if (famErr) throw new Error(`family seed: ${famErr.message}`);

  const base = { role: "fde" };
  const rows = [
    { id: MID,  slug: "verify-diff-routing-mid",  title: "vdr mid",  difficulty: "mid",  family_id: FAMILY, isomorph_of: null, ...base },
    { id: HARD, slug: "verify-diff-routing-hard", title: "vdr hard", difficulty: "hard", family_id: FAMILY, isomorph_of: null, ...base },
    // Same family + hard band but an ISOMORPH — must never be routed to.
    // Seeded with an EARLIER created_at than nothing (created now, after HARD)
    // and excluded purely by isomorph_of IS NULL.
    { id: ISO,  slug: "verify-diff-routing-iso",  title: "vdr iso",  difficulty: "hard", family_id: FAMILY, isomorph_of: "verify-diff-routing-hard", ...base },
    { id: LONE, slug: "verify-diff-routing-lone", title: "vdr lone", difficulty: "mid",  family_id: null,   isomorph_of: null, ...base },
  ];
  const { error } = await supabase.from("scenarios").insert(rows);
  if (error) throw new Error(`scenario seed: ${error.message}`);
}

(async () => {
  console.log("verify-difficulty-routing — P5.1");
  await cleanup();
  try {
    await seed();
  } catch (err) {
    console.error("seed failed:", (err as Error).message);
    await cleanup();
    process.exit(1);
  }

  // ── [1] band → sibling resolution ──
  console.log("\n[1] band → family-sibling resolution");
  const toHard = await routing.resolveScenarioForBand(MID, "hard");
  check("mid scenario + band 'hard' → hard sibling", toHard.scenarioId === HARD,
    `got ${toHard.scenarioId}`);
  check("…routed:true", toHard.routed === true);
  check("…effectiveBand = 'hard' (routed scenario's difficulty)", toHard.effectiveBand === "hard");
  check("…isomorph in the same band was NOT selected", toHard.scenarioId !== ISO);

  const same = await routing.resolveScenarioForBand(MID, "mid");
  check("same-band request returns the scenario itself", same.scenarioId === MID && same.routed === true);
  check("…effectiveBand = 'mid'", same.effectiveBand === "mid");

  const downFromHard = await routing.resolveScenarioForBand(HARD, "mid");
  check("hard scenario + band 'mid' → mid sibling", downFromHard.scenarioId === MID && downFromHard.routed === true);

  // ── [2] fallback (never fail the session) ──
  console.log("\n[2] fallback when the band is missing");
  const noEasy = await routing.resolveScenarioForBand(MID, "easy");
  check("no easy member → original scenario returned", noEasy.scenarioId === MID);
  check("…routed:false", noEasy.routed === false);
  check("…effectiveBand falls back to the ORIGINAL scenario's band ('mid')", noEasy.effectiveBand === "mid");

  const loner = await routing.resolveScenarioForBand(LONE, "hard");
  check("family-less scenario → itself, routed:false", loner.scenarioId === LONE && loner.routed === false);

  const ghost = await routing.resolveScenarioForBand("00000000-0000-4000-8000-0000000d51ff", "hard");
  check("unknown scenario id → echoed back, routed:false (no throw)",
    ghost.scenarioId === "00000000-0000-4000-8000-0000000d51ff" && ghost.routed === false);

  // ── [3] link band persistence (migration 0022) ──
  console.log("\n[3] session-link band persistence");
  // Pre-0018 databases lack session_links.org_id, which every link operation
  // selects — that's an environment limitation unrelated to P5.1. Skip.
  const { error: orgColErr } = await supabase.from("session_links").select("org_id").limit(1);
  const { error: bandColErr } = await supabase.from("session_links").select("difficulty_band").limit(1);
  if (orgColErr) {
    console.log("  SKIP: session_links.org_id missing (migration 0018 not applied) — link operations unavailable on this database.");
  } else if (bandColErr) {
    console.log("  SKIP: session_links.difficulty_band missing (migration 0022 not applied) — verifying graceful mint instead.");
    try {
      const { link } = await links.createSessionLink({
        candidateLabel: "verify-difficulty-routing-pre0022", scenarioId: MID, difficultyBand: "hard",
      });
      check("pre-0022 mint with a band does not throw (band dropped)", link.difficulty_band === null);
    } catch (err) {
      fail(`pre-0022 mint threw: ${(err as Error).message}`);
    }
  } else {
    const { link } = await links.createSessionLink({
      candidateLabel: "verify-difficulty-routing-banded", scenarioId: MID, difficultyBand: "hard",
    });
    check("mint stores the requested band on the summary", link.difficulty_band === "hard");
    const { data: row } = await supabase
      .from("session_links").select("difficulty_band").eq("id", link.id).maybeSingle();
    check("…and on the session_links row", (row as { difficulty_band: string | null } | null)?.difficulty_band === "hard");

    const { link: bandless } = await links.createSessionLink({
      candidateLabel: "verify-difficulty-routing-bandless", scenarioId: MID,
    });
    check("band-less mint stores NULL (no routing)", bandless.difficulty_band === null);
  }

  // ── [4] effective-band stamping logic (pure function level) ──
  console.log("\n[4] effective-band stamping (pure)");
  check("effectiveBandForStamp('hard') = 'hard'", routing.effectiveBandForStamp("hard") === "hard");
  check("effectiveBandForStamp(null) = null", routing.effectiveBandForStamp(null) === null);
  check("effectiveBandForStamp('expert') = null (non-band value never stamped)",
    routing.effectiveBandForStamp("expert") === null);
  // The stamped value is BandRouting.effectiveBand — the ROUTED scenario's
  // difficulty, not blindly the requested band:
  check("routed result stamps the sibling's band", toHard.effectiveBand === "hard");
  check("fallback result stamps the original's band, not the requested one",
    noEasy.effectiveBand === "mid" && noEasy.requestedBand === "easy");

  // ── [5] immutability: nothing re-routes a running session ──
  console.log("\n[5] running sessions are never re-routed");
  const { error: sessBandColErr } = await supabase.from("sessions").select("difficulty_band").limit(1);
  if (sessBandColErr) {
    console.log("  SKIP: sessions.difficulty_band missing (migration 0020 not applied) — runtime probe skipped.");
  } else {
    const { error: sErr } = await supabase.from("sessions").insert({
      id: SESS, status: "active", sandbox_id: "verify-difficulty-routing", template: "crucible-dev",
      litellm_key_alias: "vdr", model: "gemini-flash", budget_usd: 1.0, timeout_min: 60,
      deadline: "2030-01-01T00:00:00.000Z", scenario_state: {}, scenario_id: MID,
      difficulty_band: "mid",
    });
    if (sErr) {
      fail(`immutability-probe session seed failed: ${sErr.message}`);
    } else {
      // Exercise every exported P5 surface, then assert the band is untouched.
      await routing.resolveScenarioForBand(MID, "hard");
      await routing.resolveScenarioForBand(MID, "easy");
      await equating.checkBandEquating(FAMILY).catch(() => []);
      await links.createSessionLink({ candidateLabel: "verify-difficulty-routing-probe", scenarioId: MID, difficultyBand: "hard" }).catch(() => null);
      const { data: after } = await supabase
        .from("sessions").select("difficulty_band").eq("id", SESS).maybeSingle();
      check("session's difficulty_band unchanged after routing/equating/link calls",
        (after as { difficulty_band: string | null } | null)?.difficulty_band === "mid");
    }
  }

  // Static scan: no UPDATE payload in server src carries difficulty_band —
  // the only write is the INSERT in persistSessionCreated (db.ts).
  const srcRoot = resolve(here, "../src");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!p.endsWith(".ts") || p.endsWith(".test.ts")) continue;
      const text = readFileSync(p, "utf8");
      // .update({ ... difficulty_band ... }) anywhere in the file.
      if (/\.update\s*\(\s*\{[^)]*difficulty_band/s.test(text)) offenders.push(p);
    }
  };
  walk(srcRoot);
  check("no code path UPDATEs difficulty_band after insert (static scan of src/)",
    offenders.length === 0, offenders.join(", "));

  console.log("\n[cleanup]");
  await cleanup();
  console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : `FAILED: ${failures} check(s)`));
  process.exit(failures === 0 ? 0 : 1);
})();
