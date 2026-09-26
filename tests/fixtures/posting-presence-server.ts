import { expect } from '@playwright/test'
import { spawn, execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { PRESENCE_NOW, PRESENCE_REGISTRATION, presenceResponses } from './posting-presence'
import type { PresenceResponses } from './posting-presence'

const repository = fileURLToPath(new URL('../../', import.meta.url))
export const PRESENCE_PRIVATE_ROOT = path.join(repository, '.local/research/59/independent')
const exec = promisify(execFile)
export type PresenceMode = 'development' | 'production'
export interface PresenceRequest {
  event: 'request'
  sequence: number
  at: string
  url: string
  method: string
  body: string | null
  kind: 'list' | 'detail'
  synthetic: boolean
  networkSent: false
}
interface Run {
  pid: number
  command: string[]
  cwd: string
  port: number
  hmrPort?: number
  requestLog: string
  log: string
  startedAt: string
  owner?: { command: string; cwd: string; listener: string }
  terminal?: { code: number | null; signal: NodeJS.Signals | null }
  stoppedAt?: string
  closed?: boolean
}

async function availablePort() {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  return port
}
async function listener(port: number) {
  return (await exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn']).catch(error => {
    if (error.code === 1 && !error.stdout) return { stdout: '' }
    throw error
  })).stdout.trim()
}
async function owner(pid: number, port: number) {
  const values = await Promise.all([
    exec('ps', ['-p', String(pid), '-o', 'command=']),
    exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']),
    listener(port),
  ])
  return { command: values[0].stdout.trim(), cwd: values[1].stdout.trim(), listener: values[2] }
}
async function hashes(root: string, names: string[]) {
  const files: { path: string; bytes: number; sha256: string }[] = []
  async function visit(relative: string) {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name)
      if (entry.isDirectory()) await visit(name)
      else if (entry.isFile()) await add(name)
    }
  }
  async function add(name: string) {
    const bytes = await readFile(path.join(root, name))
    files.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  for (const name of names) {
    if (name.includes('.')) await add(name)
    else await visit(name)
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/** A copied app/build, private board configuration, private cache and real HTTP. */
export async function createPostingPresenceServer(directory: string, mode: PresenceMode, options: {
  sourceRoot?: string
  buildRoot?: string
  responses?: PresenceResponses
  companies?: unknown[]
} = {}) {
  directory = path.resolve(directory)
  if (!directory.startsWith(`${PRESENCE_PRIVATE_ROOT}${path.sep}`)) throw new Error('Presence artifacts must stay in the Stage59 independent directory')
  const sourceRoot = options.sourceRoot ?? process.env.ORBIT_POSTING_PRESENCE_SOURCE_ROOT ?? repository
  const buildRoot = options.buildRoot ?? process.env.ORBIT_POSTING_PRESENCE_BUILD_ROOT ?? repository
  const cwd = path.join(directory, 'runtime')
  const port = await availablePort()
  let hmrPort = mode === 'development' ? await availablePort() : undefined
  while (hmrPort === port) hmrPort = await availablePort()
  await mkdir(path.join(cwd, '.local'), { recursive: true })
  if (mode === 'production') {
    await Promise.all([
      cp(path.join(buildRoot, 'dist'), path.join(cwd, 'dist'), { recursive: true }),
      cp(path.join(buildRoot, 'dist-server'), path.join(cwd, 'dist-server'), { recursive: true }),
      symlink(path.join(repository, 'node_modules'), path.join(cwd, 'node_modules'), 'dir'),
    ])
  } else {
    await Promise.all([
      ...['index.html', 'package.json', 'tsconfig.json', 'src', 'shared', 'server'].map(name => cp(path.join(sourceRoot, name), path.join(cwd, name), { recursive: true })),
      symlink(path.join(repository, 'public'), path.join(cwd, 'public'), 'dir'),
    ])
    await mkdir(path.join(cwd, 'node_modules'))
    await Promise.all((await readdir(path.join(repository, 'node_modules'), { withFileTypes: true }))
      .filter(entry => !entry.name.startsWith('.'))
      .map(entry => symlink(path.join(repository, 'node_modules', entry.name), path.join(cwd, 'node_modules', entry.name))))
    await writeFile(path.join(cwd, 'vite.config.ts'), [
      `import original from ${JSON.stringify(path.join(sourceRoot, 'vite.config.ts'))}`,
      "import { mergeConfig } from 'vite'",
      `export default mergeConfig(original, ${JSON.stringify({
        cacheDir: path.join(cwd, 'node_modules/.vite'),
        server: { host: '127.0.0.1', hmr: { host: '127.0.0.1', port: hmrPort }, fs: { allow: [cwd, path.join(repository, 'node_modules')] } },
      })})`,
      '',
    ].join('\n'))
  }
  await writeFile(path.join(directory, 'input-hashes.json'), JSON.stringify({
    mode, sourceRoot, buildRoot, capturedAt: new Date().toISOString(),
    source: await hashes(sourceRoot, ['server', 'shared', 'src', 'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts']),
    runtime: await hashes(cwd, mode === 'production' ? ['dist', 'dist-server'] : ['server', 'shared', 'src', 'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts']),
  }, null, 2))
  const configFile = path.join(cwd, '.local/job-boards.json')
  await writeFile(configFile, JSON.stringify({ version: 1, mode: 'replace', companies: options.companies ?? [PRESENCE_REGISTRATION] }))
  const responsesFile = path.join(directory, 'upstream-responses.json')
  const clockFile = path.join(directory, 'clock-offset.txt')
  await writeFile(clockFile, String(Date.parse(PRESENCE_NOW) - Date.now()))
  async function respond(responses: PresenceResponses) {
    const temporary = `${responsesFile}.next`
    await writeFile(temporary, JSON.stringify(responses, null, 2))
    await rename(temporary, responsesFile)
  }
  await respond(options.responses ?? presenceResponses())
  const origin = `http://127.0.0.1:${port}`
  const runs: Run[] = []
  let child: ChildProcess | undefined
  let terminal: Promise<void> | undefined
  const receipt = () => writeFile(path.join(directory, 'processes.json'), JSON.stringify({ mode, origin, runs }, null, 2))

  async function start() {
    if (child) throw new Error('This presence server is already running')
    const requestLog = path.join(directory, `upstream-${runs.length + 1}.jsonl`)
    const log = path.join(directory, `server-${runs.length + 1}.log`)
    await writeFile(requestLog, '')
    const args = [
      '--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
      '--import', pathToFileURL(path.join(repository, 'tests/fixtures/posting-presence-preload.ts')).href,
      path.join(cwd, mode === 'production' ? 'dist-server/index.mjs' : 'server/index.ts'),
      ...(mode === 'production' ? ['--production'] : []),
    ]
    const stream = createWriteStream(log)
    child = spawn(process.execPath, args, {
      cwd, env: {
        ...process.env, NODE_ENV: mode, PORT: String(port), HOST: '127.0.0.1',
        ORBIT_BOARDS_FILE: configFile, ORBIT_POSTING_PRESENCE_RESPONSES: responsesFile,
        ORBIT_POSTING_PRESENCE_REQUEST_LOG: requestLog, ORBIT_POSTING_PRESENCE_CLOCK: clockFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const running = child
    if (!running.pid) throw new Error('The presence server did not spawn')
    const run: Run = {
      pid: running.pid, command: [process.execPath, ...args], cwd, port, hmrPort,
      requestLog, log, startedAt: new Date().toISOString(),
    }
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
    await receipt()
    try {
      await expect.poll(async () => {
        if (run.terminal) return `exited ${JSON.stringify(run.terminal)}: ${await readFile(log, 'utf8')}`
        try {
          const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })
          return response.ok ? (await response.json() as { mode: string }).mode : `HTTP ${response.status}`
        } catch { return 'not listening' }
      }, { message: 'The isolated presence server must become healthy', timeout: 20000 }).toBe(mode)
      run.owner = await owner(run.pid, port)
      expect(run.owner.command).toContain('posting-presence-preload.ts')
      expect(run.owner.cwd).toContain(`n${cwd}`)
      expect(run.owner.listener).toContain(`p${run.pid}`)
      if (hmrPort) expect(await listener(hmrPort)).toContain(`p${run.pid}`)
      await receipt()
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
      expect(current.command).toContain('posting-presence-preload.ts')
      running.kill('SIGTERM')
    }
    await terminal
    run.stoppedAt = new Date().toISOString()
    run.closed = (await Promise.all([port, ...(hmrPort ? [hmrPort] : [])].map(listener))).every(value => !value)
    await receipt()
    child = undefined
    terminal = undefined
    if (expectSuccess) expect(run.terminal).toEqual({ code: 0, signal: null })
    expect(run.closed).toBe(true)
  }
  async function events(): Promise<({ event: string } & Record<string, unknown>)[]> {
    const logs = await Promise.all(runs.map(run => readFile(run.requestLog, 'utf8')))
    return logs.flatMap(text => text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : [])
  }
  async function verifyProductionBytes() {
    if (mode !== 'production') return
    const html = await (await fetch(origin)).text()
    const entry = html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1]
    expect(entry).toBeTruthy()
    const expected = await readFile(path.join(cwd, 'dist', entry!))
    const response = await fetch(`${origin}${entry}`)
    const served = Buffer.from(await response.arrayBuffer())
    expect(response.status).toBe(200)
    expect(served.equals(expected)).toBe(true)
    await writeFile(path.join(directory, 'served-build.json'), JSON.stringify({
      entry, bytes: served.length, sha256: createHash('sha256').update(served).digest('hex'),
    }, null, 2))
  }
  return {
    directory, cwd, origin, configFile, runs, start, stop, respond, events, verifyProductionBytes,
    requests: async () => (await events()).filter(event => event.event === 'request') as unknown as PresenceRequest[],
    async advance(milliseconds: number) {
      const offset = Number(await readFile(clockFile, 'utf8')) + milliseconds
      await writeFile(`${clockFile}.next`, String(offset))
      await rename(`${clockFile}.next`, clockFile)
      return new Date(Date.now() + offset).toISOString()
    },
    async cacheFiles() {
      return (await readdir(path.join(cwd, '.local'))).filter(file => /cache.*\.json$/.test(file)).sort()
    },
  }
}
