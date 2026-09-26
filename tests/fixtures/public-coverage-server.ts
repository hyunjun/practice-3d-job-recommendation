import { expect } from '@playwright/test'
import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, copyFile, cp, mkdir, readFile, readdir, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { withSurveyEmptyBoards } from './public-company-survey'
import { withIntegrationEmptyBoards } from './source-integrations'
import type { CoverageEvent, CoverageRequest, CoverageWireResponse } from './public-coverage-transport'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const exec = promisify(execFile)
export type PublicCoverageMode = 'development' | 'production'
interface Run {
  pid: number
  cwd: string
  command: string[]
  port: number
  hmrPort?: number
  requestLog: string
  log: string
  startedAt: string
  configuration: { environmentOverride: false; localConfigFile: false }
  owner?: { command: string; cwd: string; listener: string; hmrListener?: string }
  terminal?: { code: number | null; signal: NodeJS.Signals | null }
  stoppedAt?: string
  closed?: boolean
}

async function availablePort(requested = 0) {
  if (requested === 8787) throw new Error('Port 8787 is reserved and must never be used by this fixture')
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

async function hashes(root: string, names: string[]) {
  const files: { path: string; bytes: number; sha256: string }[] = []
  async function visit(name: string): Promise<void> {
    const file = path.join(root, name)
    if ((await stat(file)).isDirectory()) {
      for (const entry of (await readdir(file)).sort()) await visit(path.join(name, entry))
    } else {
      const bytes = await readFile(file)
      files.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
  }
  for (const name of names) await visit(name)
  return files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

/** An unconfigured real default app: no environment or local board override. */
export async function createPublicCoverageServer(directory: string, mode: PublicCoverageMode, options: {
  cacheSeed?: unknown
  observationsSeed?: unknown
  responses?: Record<string, unknown>
  sourceRoot?: string
  buildRoot?: string
  port?: number
  clock?: string
} = {}) {
  directory = path.resolve(directory)
  const cwd = path.join(directory, 'runtime')
  const sourceRoot = options.sourceRoot ?? repository
  const buildRoot = options.buildRoot ?? repository
  const port = await availablePort(options.port)
  let hmrPort = mode === 'development' ? await availablePort() : undefined
  while (hmrPort === port) hmrPort = await availablePort()
  await mkdir(path.join(cwd, '.local'), { recursive: true })
  if (mode === 'production') {
    await Promise.all([
      ...['dist', 'dist-server'].map(name => cp(path.join(buildRoot, name), path.join(cwd, name), { recursive: true })),
      symlink(path.join(repository, 'node_modules'), path.join(cwd, 'node_modules'), 'dir'),
    ])
  } else {
    await Promise.all([
      ...['index.html', 'package.json', 'tsconfig.json'].map(file => copyFile(path.join(sourceRoot, file), path.join(cwd, file))),
      ...['src', 'shared', 'server'].map(file => cp(path.join(sourceRoot, file), path.join(cwd, file), { recursive: true })),
      copyFile(path.join(sourceRoot, 'vite.config.ts'), path.join(cwd, 'vite.original.config.ts')),
      symlink(path.join(repository, 'public'), path.join(cwd, 'public'), 'dir'),
    ])
    await mkdir(path.join(cwd, 'node_modules'))
    await Promise.all((await readdir(path.join(repository, 'node_modules'), { withFileTypes: true }))
      .filter(entry => !entry.name.startsWith('.'))
      .map(entry => symlink(path.join(repository, 'node_modules', entry.name), path.join(cwd, 'node_modules', entry.name))))
    // This fixture-only adapter isolates the second Vite's HMR/cache and font
    // transport. It preserves the repository plugins, app, default loader/API.
    await writeFile(path.join(cwd, 'vite.config.ts'), [
      "import original from './vite.original.config'",
      "import { mergeConfig } from 'vite'",
      `export default mergeConfig(original, ${JSON.stringify({
        cacheDir: path.join(cwd, 'node_modules/.vite'),
        server: { host: '127.0.0.1', hmr: { host: '127.0.0.1', port: hmrPort }, fs: { allow: [cwd, path.join(repository, 'node_modules')] } },
      })})`,
      '',
    ].join('\n'))
  }
  const sourceFiles = ['server', 'shared', 'src', 'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts']
  const source = await hashes(sourceRoot, sourceFiles)
  const build = mode === 'production' ? await hashes(buildRoot, ['dist', 'dist-server']) : undefined
  const runtime = await hashes(cwd, mode === 'production' ? ['dist', 'dist-server'] : [...sourceFiles, 'vite.original.config.ts'])
  await writeFile(path.join(directory, 'input-hashes.json'), JSON.stringify({
    mode, sourceRoot, buildRoot, capturedAt: new Date().toISOString(),
    source, build, runtime,
  }, null, 2))
  if (mode === 'production') expect(runtime).toEqual(build)
  else expect(runtime.filter(file => file.path !== 'vite.config.ts')
    .map(file => ({ ...file, path: file.path === 'vite.original.config.ts' ? 'vite.config.ts' : file.path }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'))).toEqual(source)
  const configFile = path.join(cwd, '.local/job-boards.json')
  const defaultCache = path.join(cwd, '.local/public-board-cache-v5.json')
  const observationsFile = path.join(cwd, '.local/observations-v1/public-board-cache-v5.json')
  if (options.cacheSeed !== undefined) await writeFile(defaultCache, JSON.stringify(options.cacheSeed))
  if (options.observationsSeed !== undefined) {
    await mkdir(path.dirname(observationsFile), { recursive: true })
    await writeFile(observationsFile, JSON.stringify(options.observationsSeed))
  }
  const responsesFile = path.join(directory, 'upstream-responses.json')
  const clockFile = path.join(directory, 'clock-offset-ms.txt')
  const initialClock = options.clock === undefined ? Date.now() : Date.parse(options.clock)
  if (!Number.isFinite(initialClock)) throw new Error('Invalid public coverage clock')
  await writeFile(clockFile, String(options.clock === undefined ? 0 : initialClock - Date.now()))
  async function respond(responses: Record<string, unknown>) {
    await writeFile(`${responsesFile}.next`, JSON.stringify(withIntegrationEmptyBoards(responses)))
    await rename(`${responsesFile}.next`, responsesFile)
  }
  await respond(options.responses ?? withSurveyEmptyBoards())
  const origin = `http://127.0.0.1:${port}`
  const runs: Run[] = []
  let child: ChildProcess | undefined
  let terminal: Promise<void> | undefined
  const saveReceipt = () => writeFile(path.join(directory, 'processes.json'), JSON.stringify({
    mode, origin, sourceRoot, buildRoot, configFile, defaultCache, observationsFile, clockFile, runs,
  }, null, 2))

  async function assertDefaultConfiguration() {
    await expect(access(configFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(path.join(cwd, '.local'))).filter(file => file.startsWith('configured-board-cache-'))).toEqual([])
  }

  async function start() {
    if (child && child.exitCode === null && child.signalCode === null) throw new Error('This fixture server is already running')
    await assertDefaultConfiguration()
    const index = runs.length + 1
    const requestLog = path.join(directory, `upstream-${index}.jsonl`)
    await writeFile(requestLog, '')
    const args = [
      '--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href,
      '--import', pathToFileURL(path.join(repository, 'tests/fixtures/public-coverage-preload.ts')).href,
      path.join(cwd, mode === 'production' ? 'dist-server/index.mjs' : 'server/index.ts'),
      ...(mode === 'production' ? ['--production'] : []),
    ]
    const log = path.join(directory, `server-${index}.log`)
    const stream = createWriteStream(log)
    const environment: NodeJS.ProcessEnv = {
      ...process.env, NODE_ENV: mode, PORT: String(port), HOST: '127.0.0.1',
      ORBIT_PUBLIC_COVERAGE_REQUEST_LOG: requestLog, ORBIT_PUBLIC_COVERAGE_RESPONSES: responsesFile,
      ORBIT_PUBLIC_COVERAGE_CLOCK: clockFile,
    }
    delete environment.ORBIT_BOARDS_FILE
    expect(Object.hasOwn(environment, 'ORBIT_BOARDS_FILE')).toBe(false)
    child = spawn(process.execPath, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    const running = child
    if (!running.pid) throw new Error('The default server did not spawn')
    const run: Run = {
      pid: running.pid, cwd, command: [process.execPath, ...args], port, hmrPort, requestLog, log,
      startedAt: new Date().toISOString(), configuration: { environmentOverride: false, localConfigFile: false },
    }
    runs.push(run)
    running.stdout?.pipe(stream, { end: false })
    running.stderr?.pipe(stream, { end: false })
    terminal = new Promise<void>((resolve, reject) => {
      running.once('error', reject)
      running.once('close', (code, signal) => { run.terminal = { code, signal }; stream.end(); resolve() })
    })
    await saveReceipt()
    try {
      await expect.poll(async () => {
        if (run.terminal) return `exited ${JSON.stringify(run.terminal)}: ${await readFile(log, 'utf8')}`
        try {
          const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })
          return response.ok ? (await response.json() as { mode: string }).mode : `HTTP ${response.status}`
        } catch { return 'not listening' }
      }, { message: 'The unconfigured real default server must become healthy', timeout: 20_000 }).toBe(mode)
      run.owner = await owner(run.pid, port)
      expect(run.owner.command).toContain(mode === 'production' ? 'dist-server/index.mjs' : 'server/index.ts')
      expect(run.owner.command).toContain('public-coverage-preload.ts')
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
      expect(current.command).toContain('public-coverage-preload.ts')
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
    await assertDefaultConfiguration()
  }

  async function events(): Promise<CoverageEvent[]> {
    const text = await Promise.all(runs.map(run => readFile(run.requestLog, 'utf8')))
    return text.flatMap(lines => lines.trim() ? lines.trim().split('\n').map(line => JSON.parse(line) as CoverageEvent) : [])
  }

  async function verifyProductionBytes() {
    if (mode !== 'production') return
    const html = await (await fetch(origin)).text()
    const entries = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map(match => match[1]))]
    expect(entries.some(entry => entry.endsWith('.js'))).toBe(true)
    expect(entries.some(entry => entry.endsWith('.css'))).toBe(true)
    const assets = []
    for (const entry of entries) {
      const expected = await readFile(path.join(cwd, 'dist', entry))
      const response = await fetch(`${origin}${entry}`)
      expect(response.status).toBe(200)
      const served = Buffer.from(await response.arrayBuffer())
      expect(served.equals(expected)).toBe(true)
      assets.push({ entry, bytes: served.length, sha256: createHash('sha256').update(served).digest('hex') })
    }
    await writeFile(path.join(directory, 'served-build.json'), JSON.stringify({
      assets,
    }, null, 2))
  }

  return {
    directory, cwd, origin, configFile, defaultCache, observationsFile, runs,
    start, stop, respond, events, verifyProductionBytes, assertDefaultConfiguration,
    requests: async () => (await events()).filter((event): event is CoverageRequest => event.event === 'request'),
    wireResponses: async () => (await events()).filter((event): event is CoverageWireResponse => event.event === 'http-response'),
    async advance(milliseconds: number) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error('Invalid public coverage clock advance')
      const offset = Number(await readFile(clockFile, 'utf8')) + milliseconds
      await writeFile(`${clockFile}.next`, String(offset))
      await rename(`${clockFile}.next`, clockFile)
      return new Date(Date.now() + offset).toISOString()
    },
  }
}
