#!/usr/bin/env node
/*
 * .claude/hooks/guard.js
 * PreToolUse guard for Crucible. Enforces the Hard Rules in CLAUDE.md mechanically.
 *
 * Wired in .claude/settings.json for Write | Edit | MultiEdit | Bash.
 * Contract: exit 2 = BLOCK (stderr is fed back to Claude). exit 0 = allow.
 * We invoke via `node`, so no chmod +x is required.
 *
 * Design note: we never block on malformed input — a broken guard must fail
 * open (allow), never wedge your session.
 */

'use strict';

// Server-only env names that must never reach the browser bundle.
const SECRET_ENV = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'LITELLM_MASTER_KEY',
  'LITELLM_SALT_KEY',
  'E2B_API_KEY',
  'SUPABASE_DB_URL',
  'DATABASE_URL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'LANGFUSE_SECRET_KEY',
];

// Provider-native SDKs that bypass the LiteLLM gateway. NOTE: `openai` is
// intentionally NOT here, because the OpenAI SDK is the standard *client* for
// LiteLLM (point baseURL at LITELLM_BASE_URL). If your build forbids the OpenAI
// SDK entirely, add 'openai' to this list.
const BLOCKED_SDKS = [
  '@anthropic-ai/sdk',
  '@anthropic-ai/bedrock-sdk',
  '@google/generative-ai',
  '@google/genai',
  '@mistralai/mistralai',
];

// Direct provider endpoints = bypassing LiteLLM. Always a violation.
const PROVIDER_URLS = /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com/;

function block(msg) {
  process.stderr.write(`[crucible guard] BLOCKED: ${msg}\n`);
  process.exit(2);
}
function allow() {
  process.exit(0);
}

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let evt;
  try {
    evt = JSON.parse(raw || '{}');
  } catch {
    allow(); // fail open
    return;
  }
  const tool = evt.tool_name || '';
  const input = evt.tool_input || {};
  if (tool === 'Bash') return checkBash(String(input.command || ''));
  return checkFile(String(input.file_path || ''), collectText(input));
});

function collectText(input) {
  if (typeof input.content === 'string') return input.content; // Write
  if (typeof input.new_string === 'string') return input.new_string; // Edit
  if (Array.isArray(input.edits)) {
    return input.edits.map((e) => (e && e.new_string) || '').join('\n'); // MultiEdit
  }
  return '';
}

function basename(p) {
  return p.split('/').pop() || '';
}

function checkFile(filePath, text) {
  // Never police the guard's own config/scripts: guard.js legitimately contains
  // provider names and URLs as detection patterns, and we must always be able to
  // edit the hook itself.
  if (filePath.includes('/.claude/')) return allow();

  const name = basename(filePath);

  // Rule 6 — never author a real .env (only .env.example is allowed).
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) {
    block(`writing ${name} is not allowed. Real secrets live in .env, gitignored and edited by a human.`);
  }

  // Rule 2 — a NEXT_PUBLIC_ var must never carry a secret name.
  if (/NEXT_PUBLIC_[A-Z0-9_]*(SERVICE_ROLE|MASTER_KEY|SALT|SECRET|PRIVATE|API_KEY|DB_URL|DATABASE_URL)/i.test(text)) {
    block('a NEXT_PUBLIC_ variable is being given a secret name. Only non-sensitive values may reach the browser.');
  }

  // Rules 1 & 3 — no provider-native SDK imports.
  for (const sdk of BLOCKED_SDKS) {
    const re = new RegExp(`['"]${sdk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
    if (re.test(text)) {
      block(`import of ${sdk} detected. All model calls must go through the LiteLLM gateway (LITELLM_BASE_URL).`);
    }
  }

  // Rule 3 — no direct provider URLs.
  if (PROVIDER_URLS.test(text)) {
    block('a direct model-provider URL was found. Route every model call through LITELLM_BASE_URL.');
  }

  // Rule 2 (cont.) — the web app must not read server-only secrets.
  if (filePath.includes('/apps/web/')) {
    for (const s of SECRET_ENV) {
      if (new RegExp(`process\\.env\\.${s}\\b`).test(text)) {
        block(`apps/web references the server-only secret ${s}. The browser bundle may use only NEXT_PUBLIC_* values.`);
      }
    }
  }

  allow();
}

function checkBash(cmd) {
  // Rule 6 — don't force a real .env into git (.gitignore covers the rest).
  if (/git\s+add[^\n]*\.env(?!\.example)/.test(cmd) || /git\s+add\s+-f[^\n]*\.env/.test(cmd)) {
    block('attempting to git add a .env file. Secrets must never be committed.');
  }

  // Safety net — obviously catastrophic deletes.
  const danger = [
    /rm\s+-[rf]+\s+\/(\s|$)/, // rm -rf /
    /rm\s+-[rf]+\s+~(\s|$)/, // rm -rf ~
    /rm\s+-[rf]+\s+\$HOME/, // rm -rf $HOME
    /rm\s+-[rf]+\s+\*(\s|$)/, // rm -rf *
  ];
  if (danger.some((re) => re.test(cmd))) {
    block(`refusing destructive command: ${cmd}`);
  }

  allow();
}
