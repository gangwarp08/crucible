import { Sandbox } from 'e2b'
const sbx = await Sandbox.create('crucible-dev', { timeoutMs: 60_000 })
try {
  console.log('--- /workspace ---')
  console.log((await sbx.commands.run('ls -la /workspace')).stdout)
  console.log('--- npm install ---')
  await sbx.commands.run('cd /workspace && npm install', { timeoutMs: 120_000 })
  console.log('--- node index.js (expect a DB-connection crash) ---')
  try {
    const r = await sbx.commands.run('cd /workspace && node index.js', { timeoutMs: 15_000 })
    console.log('UNEXPECTED exit', r.exitCode, r.stderr)
  } catch (e) {
    console.log('crashed as expected:\n', String(e).slice(0, 800))
  }
} finally {
  await sbx.kill()
  console.log('killed')
}
