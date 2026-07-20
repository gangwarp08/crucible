import type { Sandbox } from "e2b";

export interface PtySocket {
  readyState: number;
  close(code?: number, data?: string): void;
}

/** Reuse the same minimal socket shape for the messaging WS — close+readyState
 *  are all expireSession needs to flush the connection on teardown. */
export type MessagingSocket = PtySocket;

/** One turn in the unified persona chat — kept in memory only (events table is
 *  the durable log). Both personas share this single history: `channel` is the
 *  ADDRESSEE for candidate turns and the AUTHOR persona for persona turns, so
 *  per-channel views (verifier condensation, telemetry) can still be derived
 *  while every prompt sees the whole conversation in true arrival order. */
export interface ChatTurn {
  speaker: "candidate" | "persona";
  channel: "client" | "team";
  personaName?: string; // set on persona turns
  text: string;
  ts: string; // ISO 8601
}

/** Per-channel beat-tracking flags. Mirrored into scenarioState.personas so
 *  recruiter review + future analysis can see when each reveal fired.
 *
 *  The `client`/`team` boolean maps are the ORIGINAL family-1 (fde-db-triage)
 *  reveal flags. They are LIVE and calibrated against cohort-1 data — do NOT
 *  rename, remove, or repurpose them.
 *
 *  `firedBeatIds` (added for the scenario-driven generic persona path) tracks
 *  reveals by scenario BEAT ID rather than the fixed family-1 flag names. It is
 *  purely additive: family-1 sessions never populate it (they route through the
 *  hardcoded builders, which use the boolean flags above), and generic sessions
 *  never touch the boolean flags. Kept as a string[] on the wire (Set is not
 *  JSON-serialisable) but exposed as a Set in memory for O(1) membership. */
export interface PersonaState {
  client: { revealed_specifics: boolean; requirement_changed: boolean };
  team:   { gave_refund_hint: boolean; gave_webhook_clue: boolean; gave_shortcut_pitch: boolean };
  /** Generic-path only: ids of scenario beats already revealed/fired. Empty for
   *  the family-1 (fde-db-triage) path, which uses the boolean flags above. */
  firedBeatIds: Set<string>;
}

/** A fresh PersonaState for a brand-new session. All family-1 flags false and
 *  the generic firedBeatIds set empty. Callers that persist to jsonb should
 *  serialise firedBeatIds via `personaStateToJson`. */
export function freshPersonaState(): PersonaState {
  return {
    client: { revealed_specifics: false, requirement_changed: false },
    team:   { gave_refund_hint: false, gave_webhook_clue: false, gave_shortcut_pitch: false },
    firedBeatIds: new Set<string>(),
  };
}

/** Serialise PersonaState for the recruiter-visible scenarioState.personas
 *  jsonb: the Set becomes a string[] under `fired_beat_ids`. */
export function personaStateToJson(state: PersonaState): Record<string, unknown> {
  return {
    client: { ...state.client },
    team: { ...state.team },
    fired_beat_ids: [...state.firedBeatIds],
  };
}

/** Reconstruct PersonaState from the scenarioState.personas jsonb (rehydrate
 *  path). Tolerates rows written before firedBeatIds existed (absent →
 *  empty Set) and rows missing either channel map (→ fresh defaults). */
export function personaStateFromJson(raw: unknown): PersonaState {
  const fresh = freshPersonaState();
  if (!raw || typeof raw !== "object") return fresh;
  const obj = raw as Record<string, unknown>;
  const client = (obj["client"] as Partial<PersonaState["client"]>) ?? {};
  const team = (obj["team"] as Partial<PersonaState["team"]>) ?? {};
  const firedRaw = obj["fired_beat_ids"];
  return {
    client: {
      revealed_specifics: Boolean(client.revealed_specifics),
      requirement_changed: Boolean(client.requirement_changed),
    },
    team: {
      gave_refund_hint: Boolean(team.gave_refund_hint),
      gave_webhook_clue: Boolean(team.gave_webhook_clue),
      gave_shortcut_pitch: Boolean(team.gave_shortcut_pitch),
    },
    firedBeatIds: new Set(
      Array.isArray(firedRaw) ? firedRaw.filter((x): x is string => typeof x === "string") : [],
    ),
  };
}

/** One scheduled proactive beat. Lives inside scenarioState.scheduled_beats
 *  (jsonb on the sessions row) — that's the durability point: the schedule
 *  survives a server restart even if the in-memory registry does not.
 *
 *  Two kinds share the schedule (Slice 5.4b): persona beats (a client/team
 *  reveal, the original use) and a single verification beat fired near the
 *  deadline. `kind` is optional for back-compat — beats persisted before 5.4b
 *  have no `kind` and are treated as "persona". */
export interface ScheduledBeat {
  id: string;                                       // curveball id from scenario.json
  kind?: "persona" | "verification";               // default "persona" when absent
  channel: "client" | "team" | "verifier";
  beat?: "refund_hint" | "requirement_change" | "shortcut_pitch";  // family-1 persona kind only — the reveal flag set
  due_ts: string;                                   // ISO 8601 absolute
  fired: boolean;
  // ── Scenario-driven generic path (non-family-1) ──────────────────────────
  // When present, this beat is fired through the generic persona builders,
  // NOT the hardcoded family-1 beat prompts. `generic` marks the routing;
  // `payload_message` is the curveball's literal message the persona relays
  // in-voice. Family-1 beats leave both absent so their path is untouched.
  generic?: boolean;
  payload_message?: string;                         // curveball payload.message, delivered in-voice
}

/** L4 interactive verification (Slice 5.4b). Near the deadline the verifier
 *  picks 2–3 consequential decisions and asks the candidate to defend each,
 *  one answer per question, no adaptive follow-up. Persisted into
 *  scenarioState.verification so the in-flight exchange survives a restart. */
export interface VerificationQuestion {
  decision: string;        // the candidate decision being probed
  question: string;        // the verifier's defense question (candidate-facing)
  competency_key: string;  // competency this decision maps to (for Stage A tying)
}

export interface VerificationState {
  status: "idle" | "in_progress" | "done";
  questions: VerificationQuestion[];
  current_index: number;   // index of the question awaiting an answer
  answers: string[];       // candidate answers, parallel to questions[0..current_index)
}

/** A single buffered telemetry event waiting to be flushed to Supabase. */
export interface EventRecord {
  id: string;
  session_id: string;
  seq: number;
  type: string;
  actor: string;
  ts: string; // ISO 8601
  payload: Record<string, unknown>;
}

export interface SessionEntry {
  sandbox: Sandbox;
  sandboxId: string;
  createdAt: Date;
  deadline: Date;
  litellmKey: string;      // per-session minted key — server-only, never sent to browser
  spendTally: number;      // server-side USD accumulator (layer 2 stop)
  // Lifecycle phases (Slice 6.1): active → submitted → defending → completed.
  status: "active" | "submitted" | "defending" | "completed";
  expiryTimer: ReturnType<typeof setTimeout>;
  ptySockets: Set<PtySocket>;

  // Telemetry — events table
  nextSeq: number;                               // monotonic seq across ALL event types
  eventBuffer: EventRecord[];                    // events pending flush to Supabase
  flushTimer: ReturnType<typeof setTimeout> | null;

  // Telemetry — PTY stream batching
  ptyOutputBuffer: Buffer[];                     // sandbox→browser bytes pending flush
  ptyInputBuffer: Buffer[];                      // browser→sandbox bytes pending flush
  ptyOutputBytes: number;                        // running byte count of ptyOutputBuffer
  ptyInputBytes: number;                         // running byte count of ptyInputBuffer
  ptyOutputFlushTimer: ReturnType<typeof setTimeout> | null;
  ptyInputFlushTimer: ReturnType<typeof setTimeout> | null;

  // Telemetry — file snapshot dedup
  lastFileHashes: Map<string, string>;           // path → sha256 of last written content

  // Telemetry — transcript
  systemPromptWritten: boolean;                  // only one system row per session
  nextTranscriptSeq: number;                     // monotonic seq within transcript table

  // FDE simulation — null when this session isn't tied to a scenario.
  // scenarioState is the live game-mechanic ledger; initialized from the
  // scenario's constraints at session start and mutated as the simulation runs.
  scenarioId: string | null;
  scenarioState: Record<string, unknown>;

  // Frozen presentation metadata copied off the scenario row at session
  // creation so GET /sessions/:id can populate the candidate UI (title /
  // brief / role / difficulty) without re-querying Supabase on every HUD
  // poll. Null when scenarioId is null.
  scenarioMeta: {
    title:      string;
    brief:      string | null;
    role:       string;
    difficulty: string | null;
    // Client/team persona name+role, copied off the scenario's
    // client_persona/team_persona JSON so the candidate MESSAGES panel can
    // label channels with the scenario's actual personas (not family-1's
    // hardcoded Dana/Sam). Null when the scenario lacks the field.
    clientPersona: { name: string; role: string } | null;
    teamPersona:   { name: string; role: string } | null;
    // Dataset table names (from the fixture schema) so the candidate UI can
    // say what's IN customer.db without the candidate spelunking. Null when
    // the scenario has no dataset.
    datasetTables: string[] | null;
    // Candidate-safe deliverable component list (key + label only — never
    // accept_criteria) so the Deliverable panel renders THIS scenario's
    // fields instead of the legacy family-1 hardcode. Null when the scenario
    // doesn't define components → web falls back to the legacy four.
    deliverableComponents: { key: string; label: string }[] | null;
    // Dataset kind from the fixture's dataset.json manifest. git_repo
    // scenarios have no customer.db: the query route refuses SQL cleanly and
    // the web hides the Data tab. Null when the scenario has no dataset.
    datasetKind: "sqlite" | "git_repo" | null;
  } | null;

  // Persona messaging — ONE shared conversation for both personas (the
  // client/team channel split lives on in event types, routing, and scoring;
  // the history itself is unified so each persona's prompt sees everything).
  messagingSockets: Set<MessagingSocket>;
  chatHistory: ChatTurn[];
  personaState: PersonaState;

  // AI-assistant rolling context window (in-memory, best-effort). Holds the
  // last few user/assistant turns so the stateless /chat route can give the
  // model a short memory. Trimmed to the last 4 entries (2 exchanges) after
  // each successful turn. Intentionally NOT persisted — a server restart or a
  // browser refresh starts the window fresh, which is acceptable: it is
  // supplementary context, never required for a turn to succeed.
  assistantHistory: Array<{ role: "user" | "assistant"; text: string }>;

  // L4 interactive verification (Slice 5.4b). Live state of the near-deadline
  // defense exchange on the "verifier" channel. Mirrored into
  // scenarioState.verification for durability across a restart.
  verificationState: VerificationState;
}

/** Fresh verification state for a new session — nothing asked yet. Returns a
 *  new object each call so two sessions never alias the same mutable state. */
export function freshVerificationState(): VerificationState {
  return { status: "idle", questions: [], current_index: 0, answers: [] };
}

// In-memory session store keyed by sessionId.
// Entries are never deleted — completed sessions remain with status='completed'.
// TODO: add TTL-based eviction for old completed entries (later slice)
export const sessionRegistry = new Map<string, SessionEntry>();
