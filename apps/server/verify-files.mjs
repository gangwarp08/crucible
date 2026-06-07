import { Sandbox } from 'e2b'

const BASE = process.env.BASE_URL || 'http://localhost:3001'
const PROBE = 'crucible-fs-probe-' + Date.now()

let sessionId
let sandboxId

try {
  // 1. Create session (boots the sandbox)
  console.log('1. POST /sessions')
  const r1 = await fetch(`${BASE}/sessions`, { method: 'POST' })
  if (!r1.ok) throw new Error(`POST /sessions ${r1.status}: ${await r1.text()}`)
  ;({ sessionId } = await r1.json())
  console.log('   sessionId:', sessionId)

  // Fetch sandboxId so we can connect directly for step 3b
  const r2 = await fetch(`${BASE}/sessions/${sessionId}`)
  if (!r2.ok) throw new Error(`GET /sessions/${sessionId} ${r2.status}: ${await r2.text()}`)
  ;({ sandboxId } = await r2.json())
  console.log('   sandboxId:', sandboxId)

  // 2. Write probe file via PUT /file
  console.log('\n2. PUT /file -> /workspace/__probe.txt')
  const r3 = await fetch(`${BASE}/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, path: '/workspace/__probe.txt', content: PROBE }),
  })
  if (!r3.ok) throw new Error(`PUT /file ${r3.status}: ${await r3.text()}`)
  console.log('   wrote:', PROBE)

  // 3a. Read back via GET /file and assert
  console.log('\n3a. GET /file?path=/workspace/__probe.txt')
  const r4 = await fetch(
    `${BASE}/file?sessionId=${sessionId}&path=/workspace/__probe.txt`,
  )
  if (!r4.ok) throw new Error(`GET /file ${r4.status}: ${await r4.text()}`)
  const { content } = await r4.json()
  if (content !== PROBE) throw new Error(`ASSERTION FAILED — expected:\n  "${PROBE}"\ngot:\n  "${content}"`)
  console.log('   PASS:', content)

  // 3b. Read back via sandbox.commands.run('cat ...') and assert
  console.log('\n3b. Sandbox.connect -> cat /workspace/__probe.txt')
  const sbx = await Sandbox.connect(sandboxId)
  const cat = await sbx.commands.run('cat /workspace/__probe.txt')
  const catOut = cat.stdout.trim()
  if (catOut !== PROBE) throw new Error(`ASSERTION FAILED — expected:\n  "${PROBE}"\ngot:\n  "${catOut}"`)
  console.log('   PASS:', catOut)

  console.log('\n✅  Week 1.3 gate: file API and sandbox FS share the same filesystem.')
} finally {
  // 4. Clean up the sandbox
  if (sessionId) {
    console.log('\n4. DELETE /sessions/' + sessionId)
    await fetch(`${BASE}/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {})
    console.log('   sandbox killed')
  }
}
