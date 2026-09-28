import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { perf, assertOwnedOrigin, requireWindow, sleep } from './protocol.mjs'

const [action = 'status', portText = '5890', freeze = 'stage66-34df6ee', mode = 'production', fixture = 'actual-frozen'] = process.argv.slice(2)
const port = Number(portText), origin = `http://127.0.0.1:${port}`
assertOwnedOrigin(origin)
const ownerFile = path.join(perf, 'servers', `${port}.json`)
const script = path.join(perf, 'server.mjs')
const listeners = () => {
  try { return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean).map(Number) }
  catch (error) { if (error.status === 1) return []; throw error }
}
if (action === 'start') {
  requireWindow()
  assert.equal(listeners().length, 0, `Port ${port} is already owned by another process; refusing to touch it`)
  fs.mkdirSync(path.dirname(ownerFile), { recursive: true })
  const log = path.join(perf, 'servers', `${port}-${Date.now()}-stdout.log`)
  const fd = fs.openSync(log, 'a')
  const child = spawn(process.execPath, [script], {
    cwd: perf, detached: true, stdio: ['ignore', fd, fd],
    env: { ...process.env, PORT: portText, GLOBE_QA_FREEZE: freeze, ORBIT_TEST_MODE: mode, GLOBE_QA_FIXTURE: fixture },
  })
  fs.closeSync(fd)
  child.unref()
  let ready = false
  for (let i = 0; i < 150; i++) {
    const health = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(250) }).then(response => response.json()).catch(() => null)
    if (health?.pid === child.pid) { ready = true; console.log(JSON.stringify({ ready, pid: child.pid, origin, freeze, mode, fixture, log })); break }
    await sleep(100)
  }
  if (!ready) {
    // The PID is the child we just created, never a discovered unrelated process.
    try { process.kill(child.pid, 'SIGTERM') } catch {}
    throw new Error(`Owned server failed to start; inspect ${log}`)
  }
} else if (action === 'stop') {
  if (!fs.existsSync(ownerFile)) {
    assert.equal(listeners().length, 0, 'Unknown listener exists; refusing to kill it')
    console.log(JSON.stringify({ origin, stopped: true, reason: 'No owned server has been started' }))
  } else {
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
    assert.equal(owner.script, script)
    assert.equal(owner.origin, origin)
    let command = ''
    try { command = execFileSync('ps', ['-p', String(owner.pid), '-o', 'command='], { encoding: 'utf8' }).trim() }
    catch (error) { if (error.status !== 1) throw error }
    if (command) {
      assert(command.includes(script), 'PID has been reused; refusing to kill it')
      const cwd = execFileSync('lsof', ['-a', '-p', String(owner.pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
      assert(cwd.split('\n').includes('n' + perf), 'Owned cwd mismatch; refusing to kill it')
      assert(listeners().every(pid => pid === owner.pid), 'An unrelated listener replaced the owned server')
      process.kill(owner.pid, 'SIGTERM')
      for (let i = 0; i < 50 && listeners().includes(owner.pid); i++) await sleep(100)
    }
    assert.equal(listeners().length, 0)
    const result = { origin, pid: owner.pid, stopped: true, checkedAt: new Date().toISOString() }
    fs.writeFileSync(path.join(perf, 'servers', `${port}-cleanup.json`), JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify(result))
  }
} else {
  assert.equal(action, 'status')
  console.log(JSON.stringify({ origin, listeners: listeners(), ownerReceiptExists: fs.existsSync(ownerFile) }))
}
