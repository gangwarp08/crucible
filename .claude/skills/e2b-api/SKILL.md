---
name: e2b-api
description: >-
  Use whenever creating, controlling, exposing, or debugging E2B sandboxes in
  Crucible — sandbox lifecycle (create/connect/kill/timeout), running commands,
  filesystem read/write/watch, exposing a port (preview URL), PTY/terminal, and
  building templates. Pins the current e2b JS SDK v1 surface so the agent does
  not invent outdated method names.
---

# E2B sandbox API (Crucible)

Targets the **`e2b` JS SDK v1.x** (current at time of writing: v1.13). For exact
signatures of anything below — especially PTY and filesystem watch — confirm
against the live reference: https://e2b.dev/docs/sdk-reference/js-sdk . Do not
guess method names; if unsure, read the reference first.

For Crucible we use the **core `e2b` package with a custom template** (a real dev
environment). We do NOT use `@e2b/code-interpreter` / `runCode()` — that is for
notebook-style code execution, not a candidate's IDE.

## Auth

`Sandbox.create()` reads `E2B_API_KEY` from the environment. It is server-only —
never reference it from `apps/web`.

## Lifecycle

```ts
import { Sandbox } from 'e2b'

// Create from our template; bind the session and a timeout up front.
const sandbox = await Sandbox.create('crucible-dev', {
  timeoutMs: 15 * 60_000,            // ms, NOT seconds. Default is 300_000 (5 min).
  metadata: { sessionId },           // lets us find/audit the sandbox later
})

const id = sandbox.sandboxId          // persist this in session state

await sandbox.isRunning()             // boolean
await sandbox.setTimeout(20 * 60_000) // extend/reduce the auto-kill timer
await sandbox.getInfo()               // id, template, metadata, started/end times
await sandbox.kill()                  // free the VM (always do this on session end)
```

Reconnect to an existing sandbox from another request/instance:

```ts
const sandbox = await Sandbox.connect(id)   // id from session state
```

Timeout ceiling: max 24h (Pro) / 1h (Hobby). Keep Crucible's per-session timeout
aligned with `SESSION_TIMEOUT_MIN` and never exceed the plan ceiling.

## Running commands

```ts
const res = await sandbox.commands.run('npm test', { cwd: '/home/user/app' })
res.stdout; res.stderr; res.exitCode

// Long-running process (dev server, watcher): run in the background.
const handle = await sandbox.commands.run('npm run dev', {
  cwd: '/home/user/app',
  background: true,
  onStdout: (d) => log(d),
  onStderr: (d) => log(d),
})
// handle has its own kill(); the process keeps running otherwise.
```

Options: `cwd`, `envs`, `timeoutMs`, `background`, `onStdout`, `onStderr`.

## Filesystem

```ts
await sandbox.files.write('/home/user/app/index.ts', contents)
const text = await sandbox.files.read('/home/user/app/index.ts')
await sandbox.files.list('/home/user/app')
await sandbox.files.makeDir('/home/user/app/src')
await sandbox.files.exists('/home/user/app/index.ts')
await sandbox.files.rename('/a.txt', '/b.txt')
await sandbox.files.remove('/tmp/scratch')

// Watch for changes (e.g. to stream the candidate's edits as telemetry).
const watcher = await sandbox.files.watchDir('/home/user/app', (event) => {
  // event has the path + change type — confirm fields in the SDK reference.
})
// stop with watcher.stop() when the session ends.
```

(In some older versions this module was `sandbox.filesystem`; v1.x uses
`sandbox.files`. Match your installed version.)

## Exposing a port (preview URL)

`getHost(port)` returns only a **hostname**, not a full URL — you build the URL:

```ts
// after starting a server on port 5173 inside the sandbox
const host = sandbox.getHost(5173)
const previewUrl = `https://${host}`
```

A dev server inside the sandbox must bind `0.0.0.0` (not `localhost`) to be
reachable through the host.

## PTY (interactive terminal)

E2B exposes a pseudo-terminal for true interactive shells (the candidate's
terminal pane). The surface is roughly `sandbox.pty.create({ cols, rows, onData })`,
plus send-input / resize / kill by PID — **confirm exact signatures in the SDK
reference before using**, as this is the most version-sensitive area.

## Templates (Build System 2.0)

Custom environment is defined by a Dockerfile and built via the CLI:

```bash
e2b template build      # builds from e2b.Dockerfile -> a template id/alias
e2b template list
```

The template alias (e.g. `crucible-dev`) is what `Sandbox.create('crucible-dev')`
references. Rebuild the template when the base environment changes; don't try to
mutate a running sandbox into the desired base image at runtime.

## Crucible rules (non-negotiable)

- **Untrusted**: everything inside a sandbox is candidate-controlled. Never pipe
  sandbox output into `eval`, shell, or the host. Never run candidate commands on
  the server (CLAUDE.md Hard Rule 4).
- **Server owns lifecycle**: only the Fastify server creates/kills sandboxes and
  holds `E2B_API_KEY`. The browser never talks to E2B directly.
- **Always bound + always killed**: set `timeoutMs` at creation, align it with
  `SESSION_TIMEOUT_MIN`, and `kill()` on session end / error / timeout. A leaked
  sandbox is a leaked cost (CLAUDE.md Hard Rule 5).
- **Persist `sandboxId`** in session state (Redis/Supabase) so any server
  instance can `Sandbox.connect()` and clean up.
- **Tag with `metadata.sessionId`** so orphaned sandboxes can be found and killed.
