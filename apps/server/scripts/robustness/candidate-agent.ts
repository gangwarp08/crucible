// The persona-driven candidate agent. A Gemini LLM (on the simulator key)
// decides each next action given the live scenario context + its persona card,
// and the loop executes that action against the real session endpoints with
// human-cadence pacing between steps. There is NO scripted answer key — the
// model reasons over the same brief/docs/data a real candidate sees, so the
// resulting behavior (and score) genuinely varies with persona skill.

import type { Pacer } from "./pacing.js";
import type { Persona } from "./personas.js";
import {
  type SessionBootstrap, type MessageBus, type PersonaMsg,
  runSql, viewDoc, aiAssist, readFile, listFiles, writeFile, submitDeliverable,
  sendClient, sendTeam, drainBuffered, awaitMsg,
} from "./shared.js";
import { simChat, parseFirstJson, SimError, modelForSkill, type ChatMessage } from "./llm.js";

export interface ScenarioDoc { id: string; title: string; body: string }

export interface AgentDeps {
  sessionId: string;
  simKey: string;
  persona: Persona;
  pacer: Pacer;
  bootstrap: SessionBootstrap;
  docs: ScenarioDoc[];
  bus: MessageBus;
  maxSteps: number;
  /** Real wall-clock ceiling for the whole session (ms) — a safety stop so a
   *  stuck agent can't run past the scenario deadline. */
  maxWallMs: number;
  log: (line: string) => void;
}

export interface AgentTrace {
  steps: number;
  actions: Record<string, number>;
  submitted: boolean;
  deliverable: Record<string, string> | null;
  budgetHit: boolean;
  quotaHit: boolean;
  personaTurns: number;
  parseFailures: number;
  accruedSeconds: number;
  note: string;
}

interface AgentAction {
  tool: string;
  args?: Record<string, unknown>;
  note?: string;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…[truncated]" : s);

function toolMenu(kind: string | null): string {
  const common = [
    '- view_doc {docId} — open a reference doc (read its contents).',
    '- ask_assistant {prompt} — ask the in-session AI coding/data assistant (costs token budget).',
    '- message_client {text} — message the client stakeholder.',
    '- message_team {text} — message your engineer teammate.',
    '- think {} — pause to reason/plan (no external action).',
    '- submit_deliverable {} — signal you are ready to submit; you will then be asked to write each field. The session ends after.',
    '- finish {} — end without submitting (only if truly stuck).',
  ];
  if (kind === "git_repo") {
    return [
      '- list_files {path} — list a directory in the inherited repo.',
      '- read_file {path} — read a source file.',
      '- write_file {path, content} — edit/save a file (your fix).',
      ...common,
    ].join("\n");
  }
  // sqlite / default
  return [
    '- run_query {sql} — run read-only SQL against the scenario database.',
    ...common,
  ].join("\n");
}

function systemPrompt(d: AgentDeps): string {
  const b = d.bootstrap;
  const keys = (b.deliverableComponents ?? []).map((c) => `"${c.key}" (${c.label})`).join(", ");
  const tables = b.datasetTables?.length ? b.datasetTables.join(", ") : "(explore via SQL)";
  const docList = d.docs.map((x) => `  - ${x.id}: ${x.title}`).join("\n") || "  (none)";
  const client = b.clientPersona?.name ? `${b.clientPersona.name} (${b.clientPersona.role ?? "client"})` : "the client";
  const team = b.teamPersona?.name ? `${b.teamPersona.name} (${b.teamPersona.role ?? "engineer"})` : "your teammate";
  return [
    `You are role-playing a job candidate in a realistic, timed coding assessment. Act fully in character.`,
    ``,
    `# Your persona`,
    d.persona.brief,
    ``,
    `# The task (what the candidate sees)`,
    `Title: ${b.scenarioTitle ?? "(untitled)"}`,
    `Brief:\n${clip(b.scenarioBrief ?? "(no brief)", 4000)}`,
    ``,
    `Client stakeholder: ${client}. Teammate: ${team}.`,
    `Dataset kind: ${b.datasetKind ?? "sqlite"}. Tables: ${tables}.`,
    `Reference docs available (open with view_doc):\n${docList}`,
    `Your final deliverable must fill these fields: ${keys || "(freeform)"}.`,
    ``,
    `# How to act`,
    `Each turn, respond with ONE action as strict JSON on a single line: {"tool": "...", "args": {...}, "note": "brief reason"}.`,
    `Do not output anything except that JSON object. Available tools:`,
    toolMenu(b.datasetKind),
    ``,
    `Follow your persona's behavior instructions LITERALLY — how deeply you investigate, how much you verify, whether and how often you use the AI assistant, how much you communicate with the client and teammate, which mistakes you make, and whether you defer to the teammate's theories. Your persona is a CEILING on competence: do NOT solve the problem better, more thoroughly, or more correctly than your persona would, even if you can see the right answer. A weak persona must genuinely produce weak, partly-wrong work and hand in wrong numbers — not a polished answer.`,
    `Investigate over multiple turns at your persona's level, then submit_deliverable when you have done what your persona would do (or when time is nearly up).`,
  ].join("\n");
}

function summarizeQuery(sql: string, res: Awaited<ReturnType<typeof runSql>>): string {
  if (res.http === 409) return `query rejected: this scenario has no SQL dataset.`;
  if (res.status === "error" || res.error) return `SQL error: ${clip(res.error ?? "unknown", 300)}`;
  const cols = res.columns?.join(", ") ?? "";
  const rows = (res.rows ?? []).slice(0, 20);
  const rendered = rows.map((r) => (Array.isArray(r) ? r.join(" | ") : JSON.stringify(r))).join("\n");
  return `columns: ${cols}\nrows (${(res.rows ?? []).length}):\n${clip(rendered, 1500)}`;
}

/** Drain any persona messages that arrived since the last turn (proactive
 *  pings, curveballs) so the agent reacts to them in character. */
function pendingPersonaText(bus: MessageBus): string {
  const msgs = drainBuffered(bus);
  if (!msgs.length) return "";
  return msgs.map((m) => `[${m.channel} · ${m.persona_name}] ${clip(m.text, 500)}`).join("\n");
}

export async function runCandidateAgent(d: AgentDeps): Promise<AgentTrace> {
  const trace: AgentTrace = {
    steps: 0, actions: {}, submitted: false, deliverable: null,
    budgetHit: false, quotaHit: false, personaTurns: 0, parseFailures: 0,
    accruedSeconds: 0, note: "",
  };
  const docBody = new Map(d.docs.map((x) => [x.id, x.body]));
  const sys = systemPrompt(d);
  const history: ChatMessage[] = [{ role: "system", content: sys }];
  const startedAt = Date.now();
  const bump = (t: string) => { trace.actions[t] = (trace.actions[t] ?? 0) + 1; };
  const model = modelForSkill(d.persona.skill);

  // Orientation: read the brief before doing anything.
  await d.pacer.orient((d.bootstrap.scenarioBrief ?? "").length);

  let consecutiveParseFail = 0;
  let observation = "You have just finished reading the brief. Decide your first action.";

  while (trace.steps < d.maxSteps && Date.now() - startedAt < d.maxWallMs) {
    trace.steps++;

    // Fold in any proactive persona messages before the model decides.
    const pinged = pendingPersonaText(d.bus);
    if (pinged) observation += `\n\nNew messages arrived:\n${pinged}`;

    // Step-budget awareness so the agent converges and actually submits — a
    // submitted (even imperfect) deliverable is what makes a run scorable.
    const remaining = d.maxSteps - trace.steps;
    const lowWater = Math.max(4, Math.floor(d.maxSteps * 0.25));
    let obsForModel = observation + `\n\n(You have ~${remaining} actions left.`;
    if (remaining <= lowWater) {
      obsForModel += ` Time is nearly up — stop investigating and submit_deliverable now with your best answer for every field.`;
    }
    obsForModel += `)`;

    history.push({ role: "user", content: obsForModel });
    // Keep context bounded (system + last ~16 turns).
    const windowed: ChatMessage[] =
      history.length > 18 ? [history[0]!, ...history.slice(-17)] : history;

    let reply: string;
    try {
      const r = await simChat(d.simKey, windowed, { maxTokens: 400, temperature: 0.7, model });
      reply = r.text;
    } catch (err) {
      if (err instanceof SimError && err.isQuota) {
        trace.quotaHit = true;
        trace.note = "simulator quota/budget exhausted";
        break;
      }
      trace.note = `simulator error: ${(err as Error).message}`;
      break;
    }
    history.push({ role: "assistant", content: reply });

    const action = parseFirstJson<AgentAction>(reply);
    if (!action || !action.tool) {
      trace.parseFailures++;
      if (++consecutiveParseFail >= 3) { trace.note = "too many parse failures"; break; }
      observation = 'Your last reply was not valid JSON. Respond with exactly one JSON action, e.g. {"tool":"think","args":{}}.';
      continue;
    }
    consecutiveParseFail = 0;
    const args = (action.args ?? {}) as Record<string, unknown>;
    d.log(`step ${trace.steps}: ${action.tool} — ${clip(String(action.note ?? ""), 80)}`);

    switch (action.tool) {
      case "think": {
        bump("think");
        await d.pacer.think();
        observation = "You paused to think. What next?";
        break;
      }
      case "view_doc": {
        bump("view_doc");
        const docId = String(args.docId ?? args.id ?? "");
        await d.pacer.think();
        await viewDoc(d.sessionId, docId);
        const body = docBody.get(docId);
        if (body) { await d.pacer.read(body); observation = `Doc "${docId}":\n${clip(body, 2500)}`; }
        else observation = `No doc with id "${docId}". Available: ${d.docs.map((x) => x.id).join(", ")}.`;
        break;
      }
      case "run_query": {
        bump("run_query");
        const sql = String(args.sql ?? "");
        await d.pacer.compose(sql.length);
        const res = await runSql(d.sessionId, sql);
        const summary = summarizeQuery(sql, res);
        await d.pacer.read(summary);
        observation = `Query result:\n${summary}`;
        break;
      }
      case "ask_assistant": {
        bump("ask_assistant");
        const prompt = String(args.prompt ?? args.text ?? "");
        await d.pacer.compose(prompt.length);
        const res = await aiAssist(d.sessionId, prompt);
        if (res.budgetExhausted) {
          trace.budgetHit = true;
          observation = "The AI assistant is unavailable (token/USD budget exhausted). Continue unaided.";
        } else {
          const reply2 = res.reply ?? "(no reply)";
          await d.pacer.read(reply2);
          observation = `AI assistant replied:\n${clip(reply2, 1500)}`;
        }
        break;
      }
      case "message_client":
      case "message_team": {
        const isClient = action.tool === "message_client";
        bump(action.tool);
        const text = String(args.text ?? args.message ?? "");
        await d.pacer.compose(text.length);
        if (isClient) sendClient(d.bus, text); else sendTeam(d.bus, text);
        const chan = isClient ? "client" : "team";
        const rep = await awaitMsg(d.bus, (m) => m.channel === chan, 45_000);
        if (rep) {
          trace.personaTurns++;
          await d.pacer.read(rep.text);
          observation = `${rep.persona_name} (${chan}) replied:\n${clip(rep.text, 900)}`;
        } else {
          observation = `No reply yet from the ${chan}. Continue working.`;
        }
        break;
      }
      case "list_files": {
        bump("list_files");
        await d.pacer.think();
        const out = await listFiles(d.sessionId, String(args.path ?? "."));
        observation = out ? `Directory listing:\n${clip(out, 1500)}` : "Could not list that path.";
        break;
      }
      case "read_file": {
        bump("read_file");
        const path = String(args.path ?? "");
        const content = await readFile(d.sessionId, path);
        if (content) { await d.pacer.read(content); observation = `File ${path}:\n${clip(content, 2500)}`; }
        else observation = `Could not read ${path}.`;
        break;
      }
      case "write_file": {
        bump("write_file");
        const path = String(args.path ?? "");
        const content = String(args.content ?? "");
        await d.pacer.compose(content.length);
        const ok = await writeFile(d.sessionId, path, content);
        observation = ok ? `Saved ${path}.` : `Failed to save ${path}.`;
        break;
      }
      case "submit_deliverable": {
        bump("submit_deliverable");
        // Compose the deliverable in a DEDICATED large-token call so long field
        // text can't truncate a small decision response into invalid JSON.
        const data = await composeDeliverable(d, history, model);
        if (data) {
          await d.pacer.compose(Object.values(data).reduce((a, s) => a + s.length, 0));
          const ok = await submitDeliverable(d.sessionId, data);
          trace.submitted = ok; trace.deliverable = data;
          trace.note = ok ? "submitted" : "submit failed";
          return finalize(trace, d.pacer, startedAt);
        }
        observation = "You tried to submit but the deliverable didn't come out cleanly. Investigate a bit more, then submit again.";
        break;
      }
      case "finish": {
        bump("finish");
        trace.note = "agent finished without submitting";
        return finalize(trace, d.pacer, startedAt);
      }
      default: {
        observation = `Unknown tool "${action.tool}". Use one of the listed tools.`;
      }
    }
  }

  // Forced final submission: a persona that ran out of steps still hands in a
  // deliverable (as a real candidate under a deadline would), so the run stays
  // scorable and the score reflects the work actually done rather than a blank.
  if (!trace.submitted) {
    const data = await composeDeliverable(d, history, model);
    if (data) {
      await d.pacer.compose(Object.values(data).reduce((a, s) => a + s.length, 0));
      const ok = await submitDeliverable(d.sessionId, data);
      trace.submitted = ok; trace.deliverable = data;
      trace.note = ok ? "forced final submission" : "forced submit failed";
    }
  }

  if (!trace.note) trace.note = trace.steps >= d.maxSteps ? "max steps reached" : "wall-clock ceiling reached";
  return finalize(trace, d.pacer, startedAt);
}

/** Compose the final deliverable in a dedicated, large-token call. Returns a
 *  {fieldKey: text} map, or null if the model couldn't produce parseable JSON.
 *  Kept separate from the decision loop so long field text never truncates a
 *  small action response. */
async function composeDeliverable(
  d: AgentDeps, history: ChatMessage[], model: string,
): Promise<Record<string, string> | null> {
  const comps = d.bootstrap.deliverableComponents ?? [];
  if (!comps.length) return null;
  const spec = comps.map((c) => `- "${c.key}": ${c.label}${c.what ? " — " + clip(c.what, 200) : ""}`).join("\n");
  const prompt =
    `Write your FINAL deliverable now, in your persona's voice, based on everything you found this session. ` +
    `Output ONLY a single JSON object mapping each field key to its answer (a plain string). No prose outside the JSON, no extra keys.\n` +
    `Fields:\n${spec}\n` +
    `Include concrete numbers / SQL where relevant. A weaker persona should still submit — just with the quality that persona would produce.`;
  const base = history.length > 16 ? [history[0]!, ...history.slice(-15)] : history;
  const msgs: ChatMessage[] = [...base, { role: "user", content: prompt }];
  try {
    const r = await simChat(d.simKey, msgs, { maxTokens: 3000, temperature: 0.45, model });
    const obj = parseFirstJson<Record<string, unknown>>(r.text);
    if (!obj) return null;
    const data: Record<string, string> = {};
    for (const c of comps) {
      const v = obj[c.key];
      if (v != null) data[c.key] = typeof v === "string" ? v : JSON.stringify(v);
    }
    return Object.keys(data).length ? data : null;
  } catch { return null; }
}

function finalize(trace: AgentTrace, pacer: Pacer, startedAt: number): AgentTrace {
  trace.accruedSeconds = Math.max(pacer.accruedSeconds, Math.round((Date.now() - startedAt) / 1000));
  return trace;
}
