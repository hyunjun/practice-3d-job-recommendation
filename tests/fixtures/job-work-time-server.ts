import { expect } from '@playwright/test'
import { spawn, execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { copyFile, cp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { WORK_TIME_REGISTRATIONS, workTimeUpstreamResponses } from './job-work-time'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const exec = promisify(execFile)
type Mode = 'development' | 'production'
interface UpstreamRequest { url: string; method: string; synthetic: boolean; networkSent: false; error?: string }
interface Run {
  pid: number
  cwd: string
  command: string[]
  port: number
  hmrPort?: number
  requestLog: string
  log: string
  startedAt: string
  owner?: { command: string; cwd: string; listener: string; hmrListener?: string }
  terminal?: { code: number | null; signal: NodeJS.Signals | null }
  stoppedAt?: string
  closed?: boolean
}

async function availablePort(requested = 0) {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(requested, '127.0.0.1', resolve)
  })
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  return port
}
async function owner(pid: number, port: number) {
  const values = await Promise.all([
    exec('ps', ['-p', String(pid), '-o', 'command=']),
    exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']),
    exec('lsof', ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn']).catch(error => {
      if (error.code === 1 && !error.stdout) return { stdout: '' }
      throw error
    }),
  ])
  return { command: values[0].stdout.trim(), cwd: values[1].stdout.trim(), listener: values[2].stdout.trim() }
}

/** A real app process with an isolated configuration/cache and upstream-only preload. */
export async function createJobWorkTimeServer(directory: string, mode: Mode, options: {
  buildRoot?: string
  port?: number
  companies?: unknown[]
} = {}) {
  const buildRoot = options.buildRoot ?? repository
  const companies = options.companies ?? [...WORK_TIME_REGISTRATIONS]
  const cwd = path.join(directory, 'runtime')
  const port = await availablePort(options.port)
  let hmrPort = mode === 'development' ? await availablePort() : undefined
  while (hmrPort === port) hmrPort = await availablePort()
  await mkdir(path.join(cwd, '.local'), { recursive: true })
  if (mode === 'production') {
    await symlink(path.join(buildRoot, 'dist'), path.join(cwd, 'dist'), 'dir')
  } else {
    // Identical application files, copied only to give Vite its own root/cache.
    await Promise.all([
      ...['index.html', 'package.json', 'tsconfig.json'].map(file => copyFile(path.join(repository, file), path.join(cwd, file))),
      ...['src', 'shared'].map(file => cp(path.join(repository, file), path.join(cwd, file), { recursive: true })),
      symlink(path.join(repository, 'public'), path.join(cwd, 'public'), 'dir'),
    ])
    await mkdir(path.join(cwd, 'node_modules'))
    await Promise.all((await readdir(path.join(repository, 'node_modules'), { withFileTypes: true }))
      .filter(entry => !entry.name.startsWith('.'))
      .map(entry => symlink(path.join(repository, 'node_modules', entry.name), path.join(cwd, 'node_modules', entry.name))))
    // A second middleware-mode Vite otherwise collides with the suite server's
    // default HMR port (24678). This ignored adapter changes transport paths
    // only: the original plugins, app, loader and API stay intact. The explicit
    // package path also serves symlinked local fonts instead of returning 403.
    await writeFile(path.join(cwd, 'vite.config.ts'), [
      `import original from ${JSON.stringify(path.join(repository, 'vite.config.ts'))}`,
      "import { mergeConfig } from 'vite'",
      `export default mergeConfig(original, ${JSON.stringify({
        cacheDir: path.join(cwd, 'node_modules/.vite'),
        server: { host: '127.0.0.1', hmr: { host: '127.0.0.1', port: hmrPort }, fs: { allow: [cwd, path.join(repository, 'node_modules')] } },
      })})`,
      '',
    ].join('\n'))
  }
  const configFile = path.join(cwd, '.local/job-boards.json')
  const defaultCache = path.join(cwd, '.local/public-board-cache-v5.json')
  const defaultBytes = '{"version":5,"boards":[]}\n'
  await writeFile(defaultCache, defaultBytes)
  const configure = (next: unknown[]) => writeFile(configFile, JSON.stringify({ version: 1, mode: 'replace', companies: next }))
  await configure(companies)
  const responsesFile = path.join(directory, 'upstream-responses.json')
  const respond = (responses: Record<string, unknown>) => writeFile(responsesFile, JSON.stringify(responses))
  await respond(workTimeUpstreamResponses())
  const origin = `http://127.0.0.1:${port}`
  const runs: Run[] = []
  let child: ChildProcess | undefined
  let terminal: Promise<void> | undefined
  const saveReceipt = () => writeFile(path.join(directory, 'processes.json'), JSON.stringify({ mode, origin, buildRoot, runs }, null, 2))

  async function start() {
    if (child && child.exitCode === null && child.signalCode === null) throw new Error('This fixture server is already running')
    const index = runs.length + 1
    const requestLog = path.join(directory, `upstream-${index}.jsonl`)
    await writeFile(requestLog, '')
    const args = [
      '--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
      '--import', pathToFileURL(path.join(repository, 'tests/fixtures/job-work-time-preload.ts')).href,
      path.join(mode === 'production' ? buildRoot : repository, mode === 'production' ? 'dist-server/index.mjs' : 'server/index.ts'),
      ...(mode === 'production' ? ['--production'] : []),
    ]
    const log = path.join(directory, `server-${index}.log`)
    const stream = createWriteStream(log)
    child = spawn(process.execPath, args, {
      cwd, env: {
        ...process.env, NODE_ENV: mode, PORT: String(port), HOST: '127.0.0.1',
        ORBIT_BOARDS_FILE: configFile, ORBIT_JOB_WORK_TIME_REQUEST_LOG: requestLog,
        ORBIT_JOB_WORK_TIME_RESPONSES_FILE: responsesFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const running = child
    if (!running.pid) throw new Error('The configured server did not spawn')
    const run: Run = { pid: running.pid, cwd, command: [process.execPath, ...args], port, hmrPort, requestLog, log, startedAt: new Date().toISOString() }
    runs.push(run)
    running.stdout?.pipe(stream, { end: false })
    running.stderr?.pipe(stream, { end: false })
    terminal = new Promise<void>((resolve, reject) => {
      running.once('error', reject)
      running.once('close', (code, signal) => {
        run.terminal = { code, signal }
        stream.end()
        resolve()
      })
    })
    await saveReceipt()
    try {
      await expect.poll(async () => {
        if (run.terminal) return `exited ${JSON.stringify(run.terminal)}: ${await readFile(log, 'utf8')}`
        try {
          const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })
          return response.ok ? (await response.json() as { mode: string }).mode : `HTTP ${response.status}`
        } catch { return 'not listening' }
      }, 'The real configured server must become healthy').toBe(mode)
      run.owner = await owner(run.pid, port)
      expect(run.owner.command).toContain(mode === 'production' ? 'dist-server/index.mjs' : 'server/index.ts')
      expect(run.owner.cwd).toContain(`n${cwd}`)
      expect(run.owner.listener).toContain(`p${run.pid}`)
      if (hmrPort) {
        run.owner.hmrListener = (await owner(run.pid, hmrPort)).listener
        expect(run.owner.hmrListener).toContain(`p${run.pid}`)
      }
      await saveReceipt()
    } catch (error) {
      await stop(false)
      throw error
    }
  }

  async function stop(expectSuccess = true) {
    if (!child || !terminal) return
    const running = child
    const run = runs[runs.length - 1]
    if (running.exitCode === null && running.signalCode === null) {
      const current = await owner(run.pid, port)
      expect(current.cwd).toContain(`n${cwd}`)
      expect(current.command).toContain('job-work-time-preload.ts')
      // This handle belongs to the spawned child and is never reused for another PID.
      running.kill('SIGTERM')
    }
    await terminal
    run.stoppedAt = new Date().toISOString()
    const listening = await Promise.all([port, ...(hmrPort ? [hmrPort] : [])].map(number =>
      exec('lsof', ['-nP', `-iTCP:${number}`, '-sTCP:LISTEN', '-Fpn']).catch(error => {
        if (error.code === 1 && !error.stdout) return { stdout: '' }
        throw error
      })))
    run.closed = listening.every(result => result.stdout === '')
    await saveReceipt()
    child = undefined
    terminal = undefined
    if (expectSuccess) expect(run.terminal).toEqual({ code: 0, signal: null })
    expect(run.closed).toBe(true)
  }

  async function requests() {
    const text = await Promise.all(runs.map(run => readFile(run.requestLog, 'utf8')))
    return text.flatMap(lines => lines.trim() ? lines.trim().split('\n').map(line => JSON.parse(line) as UpstreamRequest) : [])
  }
  async function verifyProductionBytes() {
    if (mode !== 'production') return
    const html = await (await fetch(origin)).text()
    const entry = html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1]
    expect(entry).toBeTruthy()
    const expected = await readFile(path.join(buildRoot, 'dist', entry!))
    const response = await fetch(`${origin}${entry}`)
    expect(response.status).toBe(200)
    const served = Buffer.from(await response.arrayBuffer())
    expect(served.equals(expected)).toBe(true)
    await writeFile(path.join(directory, 'served-build.json'), JSON.stringify({
      entry, bytes: served.length, sha256: createHash('sha256').update(served).digest('hex'),
    }, null, 2))
  }
  return {
    cwd, origin, configFile, defaultCache, defaultBytes, runs, start, stop, configure, respond, requests, verifyProductionBytes,
    async cacheFiles() {
      // This existing helper returns full-body caches; presence has its own sidecar.
      return (await readdir(path.join(cwd, '.local'))).filter(file => file.startsWith('configured-board-cache-v5-') && file.endsWith('.json') && !file.endsWith('.presence-v1.json')).sort()
    },
  }
}
