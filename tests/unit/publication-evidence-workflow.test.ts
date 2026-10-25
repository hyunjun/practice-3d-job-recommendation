import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const workflow = await readFile(fileURLToPath(new URL('../../.github/workflows/collect-catalog.yml', import.meta.url)), 'utf8')
function step(name: string) {
  const marker = `      - name: ${name}\n`
  const start = workflow.indexOf(marker)
  if (start < 0 || workflow.indexOf(marker, start + marker.length) !== -1) throw new Error(`Missing/duplicate workflow step: ${name}`)
  const end = workflow.indexOf('\n      - ', start + marker.length)
  return workflow.slice(start, end < 0 ? undefined : end)
}
const collect = step('Collect and atomically publish')
const preparation = step('Verify completed publication evidence')
const upload = step('Retain publication evidence')
function collectScript() {
  const marker = '        run: |\n'
  const offset = collect.indexOf(marker)
  if (offset < 0) throw new Error('Collect shell block missing')
  return collect.slice(offset + marker.length).split('\n').filter(line => line.length > 0).map(line => {
    if (!line.startsWith('          ')) throw new Error('Unexpected shell indentation')
    return line.slice(10)
  }).join('\n') + '\n'
}
let root: string
let bin: string
let githubOutput: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'orbit-evidence-workflow-'))
  bin = path.join(root, 'bin')
  githubOutput = path.join(root, 'github-output')
  await mkdir(bin)
  await writeFile(githubOutput, '')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('publication evidence workflow wiring', () => {
  it('prepares only a nonempty current collect output record, including after collection failure', () => {
    expect(collect).toContain('id: collect')
    expect(collect).toContain('ORBIT_PUBLICATION_EVIDENCE_FILE: ${{ runner.temp }}/orbit-publication-evidence.json')
    expect(preparation).toContain("if: ${{ always() && (inputs.operation || 'collect') == 'collect' && steps.collect.outputs.output_record != '' }}")
    expect(preparation).toContain('PUBLICATION_OUTPUT_RECORD: ${{ steps.collect.outputs.output_record }}')
    expect(preparation).toContain('run: node scripts/prepare-publication-evidence.mjs --output-record "$PUBLICATION_OUTPUT_RECORD" --evidence-file "$ORBIT_PUBLICATION_EVIDENCE_FILE"')
    expect(preparation).not.toContain('continue-on-error')
  })

  it('uploads one exact JSON path as an explicit ZIP with pinned action and strict readiness guards', () => {
    expect(upload).toContain("if: ${{ always() && (inputs.operation || 'collect') == 'collect' && steps.prepare_evidence.outcome == 'success' && steps.prepare_evidence.outputs.ready == 'true' }}")
    expect(upload).toContain('uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9')
    const entries = [...upload.matchAll(/^          ([a-z-]+): (.+)$/gm)].map(match => [match[1], match[2]])
    expect(entries).toHaveLength(7)
    expect(Object.fromEntries(entries)).toEqual({
      name: 'publication-evidence-${{ github.run_id }}-${{ github.run_attempt }}',
      path: '${{ runner.temp }}/orbit-publication-evidence.json',
      archive: 'true', 'retention-days': '7', 'if-no-files-found': 'error',
      overwrite: 'false', 'include-hidden-files': 'false',
    })
    expect(upload).not.toContain('continue-on-error')
    expect(workflow.match(/actions\/upload-artifact@/g)).toHaveLength(1)
  })
})

async function shell(options: { collectExit?: number; teeExit?: number; failRecord?: boolean; failOutput?: boolean; operation?: string } = {}) {
  // Only npm/tee/mktemp are substituted. Execute the actual workflow shell with
  // GitHub's bash -e -o pipefail semantics; no collector, provider or npm runs.
  await writeFile(path.join(bin, 'npm'), `#!/bin/bash
printf '%s\\n' "$@" >> "$FIXTURE_ROOT/npm-argv"
printf '%s\\n' "$TMPDIR" >> "$FIXTURE_ROOT/raw-roots"
printf 'synthetic stdout\\n'
printf 'synthetic stderr\\n' >&2
printf '{"operation":"%s","success":false,"published":false,"code":"SYNTHETIC","elapsedMs":1}\\n' "$ORBIT_OPERATION"
exit "$COLLECT_EXIT"
`, { mode: 0o700 })
  await writeFile(path.join(bin, 'tee'), `#!/bin/bash
/usr/bin/tee "$@"
status=$?
if (( status != 0 )); then exit "$status"; fi
exit "$TEE_EXIT"
`, { mode: 0o700 })
  await writeFile(path.join(bin, 'mktemp'), `#!/bin/bash
if [[ "$1" != "-d" && "$FAIL_RECORD" == 1 ]]; then exit 19; fi
if [[ "$#" -eq 1 && "$1" == "-d" ]]; then
  exec /usr/bin/mktemp -d "$FIXTURE_ROOT/raw.XXXXXX"
fi
exec /usr/bin/mktemp "$@"
`, { mode: 0o700 })
  const script = path.join(root, 'collect.sh')
  await writeFile(script, collectScript())
  return new Promise<{ code: number | string | null; stdout: string; stderr: string }>((resolve, reject) => {
    execFile('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', script], {
      env: {
        ...process.env, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: root, RUNNER_TEMP: root, FIXTURE_ROOT: root,
        GITHUB_OUTPUT: options.failOutput ? root : githubOutput, ORBIT_OPERATION: options.operation ?? 'collect',
        ORBIT_PUBLICATION_EVIDENCE_FILE: path.join(root, 'evidence.json'),
        COLLECT_EXIT: String(options.collectExit ?? 0), TEE_EXIT: String(options.teeExit ?? 0), FAIL_RECORD: options.failRecord ? '1' : '0',
      },
      timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error?.killed || error?.signal) reject(new Error(`Workflow fixture did not exit normally: ${String(error)}`))
      else resolve({ code: error?.code ?? 0, stdout, stderr })
    })
  })
}
async function expectRawCleanup() {
  const roots = (await readFile(path.join(root, 'raw-roots'), 'utf8')).trim().split('\n')
  expect(roots.length).toBeGreaterThan(0)
  for (const raw of roots) {
    const diagnostic = JSON.stringify({ raw, root })
    expect(raw.startsWith(`${root}${path.sep}`), diagnostic).toBe(true)
    await expect(stat(raw), diagnostic).rejects.toMatchObject({ code: 'ENOENT' })
  }
}

describe('actual collect shell with bounded synthetic executables', () => {
  it.each([
    { collectExit: 0, teeExit: 0, expected: 0 },
    { collectExit: 7, teeExit: 0, expected: 7 },
    { collectExit: 0, teeExit: 9, expected: 9 },
    { collectExit: 7, teeExit: 9, expected: 7 },
  ])('preserves collect=$collectExit / tee=$teeExit as exit $expected', async ({ collectExit, teeExit, expected }) => {
    const result = await shell({ collectExit, teeExit })
    expect(result.code).toBe(expected)
    expect(result.stdout).toContain('synthetic stdout\n')
    expect(result.stdout).toContain('synthetic stderr\n')
    expect(result.stderr).toBe(teeExit ? 'Publication output capture failed.\n' : '')
    const recordLines = (await readFile(githubOutput, 'utf8')).trim().split('\n')
    expect(recordLines).toHaveLength(1)
    expect(recordLines[0]).toMatch(/^output_record=/)
    const record = recordLines[0].slice('output_record='.length)
    expect(record.startsWith(`${root}/orbit-publication-output.`)).toBe(true)
    expect((await stat(record)).mode & 0o777).toBe(0o600)
    expect(await readFile(record, 'utf8')).toBe(result.stdout)
    expect(await readFile(path.join(root, 'npm-argv'), 'utf8')).toBe('run\npublish:catalog\n--\ncollect\n')
    await expectRawCleanup()
  })

  it('binds fresh unique records and never overwrites or falls back to an old output file', async () => {
    const stale = path.join(root, 'orbit-publication-output.old')
    await writeFile(stale, 'stale-valid-looking-record')
    expect((await shell()).code).toBe(0)
    const first = (await readFile(githubOutput, 'utf8')).trim().slice('output_record='.length)
    const firstBytes = await readFile(first)
    expect((await shell()).code).toBe(0)
    const records = (await readFile(githubOutput, 'utf8')).trim().split('\n').map(line => line.slice('output_record='.length))
    expect(new Set(records).size).toBe(2)
    expect(records).not.toContain(stale)
    expect(await readFile(first)).toEqual(firstBytes)
    expect(await readFile(stale, 'utf8')).toBe('stale-valid-looking-record')
    await expectRawCleanup()
  })

  it.each(['record-creation', 'output-binding'] as const)('never starts collection if %s fails', async failure => {
    const stale = path.join(root, 'orbit-publication-output.old')
    await writeFile(stale, 'old bytes')
    const result = await shell({ failRecord: failure === 'record-creation', failOutput: failure === 'output-binding' })
    expect(result.code).not.toBe(0)
    await expect(stat(path.join(root, 'npm-argv'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(githubOutput, 'utf8')).toBe('')
    expect(await readFile(stale, 'utf8')).toBe('old bytes')
  })

  it('keeps rollback outside evidence capture and preserves its exit code', async () => {
    const result = await shell({ operation: 'rollback', collectExit: 7 })
    expect(result.code).toBe(7)
    expect(await readFile(githubOutput, 'utf8')).toBe('')
    expect((await readdir(root)).filter(name => name.startsWith('orbit-publication-output.'))).toEqual([])
    expect(await readFile(path.join(root, 'npm-argv'), 'utf8')).toBe('run\npublish:catalog\n--\nrollback\n')
    await expectRawCleanup()
  })
})
