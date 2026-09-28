import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { performance as hostClock } from 'node:perf_hooks'
import { chromium, expect } from '@playwright/test'
import {
  perf, oracle, profile, filters, sha, requireWindow, readFreeze, auditFreeze,
  assertOwnedOrigin, sleep, quantile,
} from './protocol.mjs'

const windowAcknowledgement = requireWindow()
const origin = process.env.GLOBE_QA_ORIGIN ?? 'http://127.0.0.1:5890'
const port = assertOwnedOrigin(origin).port
const owner = JSON.parse(fs.readFileSync(path.join(perf, 'servers', `${port}.json`), 'utf8'))
assert.equal(owner.origin, origin)
const scenario = process.env.GLOBE_QA_SCENARIO ?? 'refresh'
assert(['cold', 'refresh'].includes(scenario))
const profiling = process.env.GLOBE_QA_PROFILE === '1'
const purpose = process.env.GLOBE_QA_PURPOSE ?? (profiling ? 'diagnostic' : 'native')
assert(['native', 'qualification', 'diagnostic'].includes(purpose))
assert.equal(profiling, purpose === 'diagnostic')
const runs = Number(process.env.GLOBE_QA_RUNS ?? (purpose === 'native' ? '5' : '1'))
assert(Number.isInteger(runs) && runs > 0 && runs <= 5)
assert.equal(runs, purpose === 'native' ? 5 : 1, 'Native aggregates require five complete runs; qualification and diagnostics are separate single runs')
const label = process.env.GLOBE_QA_LABEL ?? `${owner.freeze}-${scenario}-${owner.mode}${profiling ? '-diagnostic' : ''}`
assert.match(label, /^[a-zA-Z0-9_-]+$/)
const output = path.join(perf, 'runs', label)
assert(!fs.existsSync(output), 'Never overwrite complete, failed or partial runs; choose a new attempt label')
fs.mkdirSync(output, { recursive: true })
const health = await (await fetch(origin + '/api/health')).json()
assert.equal(health.fixture, 'actual-frozen')
assert.equal(health.pid, owner.pid)
assert.equal(health.startedAt, owner.startedAt)
assert.equal(health.manifestSha256, owner.manifestSha256)
assert.equal(health.wireReceipt.actualSha256, oracle.catalogSha256)
const freeze = readFreeze(health.freeze)
auditFreeze(freeze)
const sourceCatalog = JSON.parse(fs.readFileSync(path.join(perf, 'actual-frozen/catalog.json'), 'utf8'))
const descriptions = new Map(oracle.landmarks.map(landmark => [
  landmark.id, sourceCatalog.jobs.find(job => job.id === landmark.id).description,
]))
// Release the large Node graph before any measured interval. Only two descriptions remain needed.
sourceCatalog.jobs.length = 0
const control = async (route, body) => {
  const response = await fetch(origin + '/__qa/' + route, {
    method: route === 'state' ? 'GET' : 'POST',
    headers: { 'x-globe-qa-key': owner.token, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const result = await response.json()
  assert(response.ok, JSON.stringify(result))
  return result
}
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const summaries = []
const heading = page => page.locator('.city-hero-caption h2')
const cityRow = (page, city) => page.getByRole('button', { name: new RegExp(`^${city}, 추천 회사 [0-9]+곳 보기$`) })
const pins = page => page.locator('.globe-pin').evaluateAll(nodes => nodes.map(node => ({
  label: node.getAttribute('aria-label'), transform: node.style.transform,
})))
async function drag(page, box, actions, moves = 120, amplitude = 0.19) {
  const x = box.x + box.width * 0.5, y = box.y + box.height * 0.68
  await page.mouse.move(x, y)
  await page.mouse.down()
  const start = hostClock.now(), delays = []
  try {
    for (let step = 0; step < moves; step++) {
      const due = start + step * 1000 / 60
      await sleep(due - hostClock.now())
      delays.push(hostClock.now() - due)
      const angle = step / (moves - 1) * Math.PI * 2
      await page.mouse.move(x + Math.sin(angle) * box.width * amplitude, y + (Math.cos(angle) - 1) * box.height * 0.075)
    }
  } finally { await page.mouse.up() }
  actions.push({ type: 'native-drag', moves, scheduledHz: 60, amplitude, durationMs: hostClock.now() - start, dispatchLagP95: quantile(delays, .95), dispatchLagMax: Math.max(...delays) })
}
async function correctness(page, run) {
  const settled = async () => {
    const panel = page.locator('.panel-container:visible')
    await expect(panel).toBeVisible()
    // Stage66 predates the worker's busy attribute and projects synchronously.
    // The known legacy build alone may use ARIA's absent/default false value.
    if (await panel.getAttribute('aria-busy') === null)
      assert.equal(health.freeze, 'stage66-34df6ee', 'Worker builds must expose their publication readiness')
    else await expect(panel).toHaveAttribute('aria-busy', 'false', { timeout: 120000 })
  }
  await expect(heading(page)).toContainText('암스테르담')
  await expect(page.locator('.city-coordinate')).toHaveText('52.37°N')
  await expect(page.getByText('Backend Engineer — Synthetic Arrival Bootstrap Amsterdam', { exact: true })).toHaveCount(0)
  const initialCounts = await page.locator('.city-detail-count strong').allTextContents()
  await page.locator('.data-status-button').click()
  await expect(page.locator('.coverage-stats strong')).toHaveText(oracle.coverageDisplay)
  await page.getByRole('button', { name: '닫기', exact: true }).click()
  // The pinned raw jobs require Java (Wise) and Java/SQL (Databricks).
  // Their skill overlap is deliberately enabled only AFTER the completed
  // timing interval; every native run keeps its original measured profile.
  await page.getByRole('button', { name: '내 프로필 편집', exact: true }).click()
  for (const skill of ['Java', 'SQL']) {
    await page.locator('#profile-skill').fill(skill)
    await page.getByRole('button', { name: '기술 추가', exact: true }).click()
    await expect(page.getByRole('button', { name: `${skill} 삭제`, exact: true })).toBeVisible()
  }
  await page.getByRole('button', { name: '변경 사항 적용', exact: true }).click()
  await settled()
  const landmarks = []
  for (const landmark of oracle.landmarks) {
    if (await page.getByRole('button', { name: '모든 도시', exact: true }).count()) {
      await page.getByRole('button', { name: '모든 도시', exact: true }).click()
      await settled()
    }
    await page.getByLabel('도시, 회사 또는 포지션 검색').fill(landmark.query)
    await settled()
    await cityRow(page, landmark.cityName).click()
    await settled()
    await expect(heading(page)).toContainText(landmark.cityName)
    await expect(page.locator('.city-coordinate')).toHaveText(landmark.coordinateDisplay)
    const card = page.locator('.company-card').filter({ has: page.getByRole('heading', { name: landmark.companyName, exact: true }) })
    await expect(card).toHaveCount(1)
    const job = card.getByRole('button', { name: landmark.title, exact: true })
    if (!await job.count()) {
      await card.getByRole('button', { name: /^전체 [0-9]+개 공고 보기$/ }).click()
      for (let next = 0; next < 50 && !await job.count(); next++) {
        const button = card.getByRole('button', { name: '다음 공고 페이지', exact: true }).first()
        assert(await button.count() && await button.isEnabled(), `Literal landmark missing: ${landmark.id}`)
        await button.click()
      }
    }
    await job.click()
    await expect(page.getByRole('dialog')).toContainText(landmark.locationLabel)
    await expect(page.getByRole('link', { name: '원문에서 지원하기', exact: true })).toHaveAttribute('href', landmark.url)
    await page.getByText('채용공고 원문 읽기', { exact: false }).click()
    await expect(page.locator('.job-description p')).toHaveText(descriptions.get(landmark.id))
    landmarks.push({ id: landmark.id, title: landmark.title, company: landmark.companyName, url: landmark.url, descriptionSha256: sha(descriptions.get(landmark.id)) })
    await page.screenshot({ path: path.join(output, `run-${run}-${landmark.cityIds[0]}-landmark.png`) })
    await page.getByRole('button', { name: '닫기', exact: true }).click()
  }
  return { coverage: oracle.coverageDisplay, amsterdamObservedFilteredCounts: initialCounts, landmarks,
    landmarkProfileSkillsAddedAfterTiming: ['Java', 'SQL'] }
}
try {
  for (let run = 1; run <= runs; run++) {
    await control('arm', { scenario, runId: `${label}-${run}` })
    const context = await browser.newContext({
      baseURL: origin, viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1,
      reducedMotion: 'no-preference', serviceWorkers: 'block', locale: 'en-US',
      // Layered egress denial also covers worker traffic. No provider links are activated.
      proxy: { server: 'http://127.0.0.1:9', bypass: '127.0.0.1,localhost' },
    })
    const page = await context.newPage(), unexpected = [], errors = [], requests = [], actions = []
    page.on('pageerror', error => errors.push(error.message))
    context.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push({ url: request.url(), method: request.method() }) })
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue()
      unexpected.push(route.request().url())
      return route.abort('blockedbyclient')
    })
    await context.routeWebSocket('**/*', route => {
      const url = new URL(route.url())
      if (url.host === new URL(origin).host) route.connectToServer()
      else { unexpected.push(route.url()); route.close() }
    })
    await page.addInitScript({ content: `(() => {
      const NativeDate = Date, fixed = ${Date.parse(oracle.fixedNow)};
      window.Date = new Proxy(NativeDate, {
        construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [fixed], newTarget); },
        apply() { return new NativeDate(fixed).toString(); },
        get(target, key, receiver) { return key === 'now' ? () => fixed : Reflect.get(target, key, receiver); }
      });
      localStorage.setItem('orbit.v1.profile', ${JSON.stringify(JSON.stringify(profile))});
      localStorage.setItem('orbit.v1.exploration', ${JSON.stringify(JSON.stringify({ source: 'public', mapMode: 'globe', panelTab: 'cities', selectedId: null, filters }))});
    })();` })
    await page.addInitScript({ content: fs.readFileSync(path.join(perf, 'actual-recorder.js'), 'utf8') })
    const session = await context.newCDPSession(page)
    await session.send('Performance.enable')
    await session.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    try {
      await page.goto('/')
      await expect(page.getByRole('button', { name: '3D 지구', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.earth-canvas')).toHaveClass(/is-ready/)
      await expect(page.locator('.flat-map')).toHaveCount(0)
      await page.evaluate(() => document.fonts.ready.then(() => undefined))
      const canvas = page.locator('.earth-canvas > canvas'), box = await canvas.boundingBox()
      assert(box)
      const graphics = await canvas.evaluate(element => {
        const gl = element.getContext('webgl2'), ext = gl.getExtension('WEBGL_debug_renderer_info')
        return { version: gl.getParameter(gl.VERSION), renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), width: element.width, height: element.height }
      })
      assert.match(graphics.version, /WebGL 2/)
      if (scenario === 'refresh') {
        await expect(page.locator('.city-row-main')).toHaveCount(2)
        await expect(cityRow(page, '암스테르담')).toHaveAttribute('aria-label', '암스테르담, 추천 회사 1곳 보기')
        await page.locator('.data-status-button').click()
        await page.getByRole('button', { name: '새로고침', exact: true }).click()
        await page.getByRole('button', { name: '닫기', exact: true }).click()
      } else await expect(page.locator('.city-row-main')).toHaveCount(0)
      await expect.poll(async () => (await control('state')).gate?.phase).toBe('headers-held')
      // Untimed visual proof of real rotation, including an empty cold-start globe.
      await canvas.screenshot({ path: path.join(output, `run-${run}-rotation-before.png`) })
      await drag(page, box, actions, 35, 0.11)
      await canvas.screenshot({ path: path.join(output, `run-${run}-rotation-after.png`) })
      const beforeImage = fs.readFileSync(path.join(output, `run-${run}-rotation-before.png`))
      assert.notEqual(sha(beforeImage), sha(fs.readFileSync(path.join(output, `run-${run}-rotation-after.png`))))
      await page.getByRole('region', { name: /^3D 기회 지도\./ }).focus()
      await page.keyboard.press('Home')
      await page.waitForTimeout(1500)
      actions.length = 0
      const initialPins = await pins(page), metricBefore = await session.send('Performance.getMetrics')
      if (profiling) {
        await session.send('Profiler.enable'); await session.send('Profiler.setSamplingInterval', { interval: 1000 }); await session.send('Profiler.start')
      }
      await page.evaluate(scenario => { Object.assign(window.__arrivalQA, { scenario, active: true, startedAt: performance.now() }) }, scenario)
      const body = control('body')
      await drag(page, box, actions)
      await body
      assert.equal((await control('state')).gate.phase, 'eof-held')
      if (scenario === 'refresh') {
        // A keyed city row retains focus when actual counts reorder the city list.
        // No selector or geometry lookup is performed between EOF and input dispatch.
        await cityRow(page, '암스테르담').focus()
        await expect(cityRow(page, '암스테르담')).toBeFocused()
      } else await page.getByRole('region', { name: /^3D 기회 지도\./ }).focus()
      await page.evaluate(() => { window.__arrivalQA.eofArmed = true; window.__arrivalQA.marks.push({ type: 'eof-command-sent', at: performance.now() }) })
      const eofHostStart = hostClock.now()
      await control('eof')
      await sleep(25)
      const inputHostStart = hostClock.now()
      if (scenario === 'refresh') await page.keyboard.press('Enter')
      else await page.keyboard.press('ArrowRight')
      actions.push({ type: scenario === 'refresh' ? 'queued-city-activation' : 'queued-globe-keyboard-rotation', afterEofControlMs: inputHostStart - eofHostStart, dispatchCompletionMs: hostClock.now() - inputHostStart })
      await drag(page, box, actions)
      if (scenario === 'cold') {
        await expect.poll(() => page.evaluate(() => window.__arrivalQA.catalogInteractiveAt), { timeout: 120000 }).not.toBeNull()
        await cityRow(page, '암스테르담').click()
      }
      await expect(heading(page)).toContainText('암스테르담', { timeout: 120000 })
      await expect.poll(() => page.evaluate(() => window.__arrivalQA.inputs.length), { timeout: 120000 }).toBe(1)
      await expect.poll(() => page.evaluate(() => window.__arrivalQA.catalogInteractiveAt), { timeout: 120000 }).not.toBeNull()
      await page.waitForTimeout(1500)
      const measured = await page.evaluate(() => {
        const qa = window.__arrivalQA
        qa.active = false; qa.endedAt = performance.now()
        return { ...qa, resources: performance.getEntriesByType('resource').filter(entry => entry.name.includes('/api/catalog?')).map(entry => entry.toJSON()) }
      })
      const metricAfter = await session.send('Performance.getMetrics')
      if (profiling) fs.writeFileSync(path.join(output, `run-${run}.cpuprofile`), JSON.stringify((await session.send('Profiler.stop')).profile))
      const metricDeltas = Object.fromEntries(metricAfter.metrics.map(item => [item.name, item.value - (metricBefore.metrics.find(before => before.name === item.name)?.value ?? 0)]))
      assert.equal(measured.inputs.length, 1)
      assert(measured.inputs.every(input => input.trusted))
      assert.equal(measured.pending.length, 0)
      assert(measured.frames.length > 100)
      assert(measured.trustedDragMoves >= 100)
      assert(!measured.visibility.some(entry => entry.hidden))
      const actualResources = measured.resources.filter(entry => entry.encodedBodySize === health.wireReceipt.wireBytes && entry.decodedBodySize === oracle.catalogBytes)
      assert.equal(actualResources.length, 1, 'Exactly one complete full-size actual HTTP body must reach the page')
      const resource = actualResources[0], intervals = measured.frames.map(frame => frame.interval)
      const summary = {
        run, scenario, profiling, purpose, aggregateEligible: purpose === 'native',
        durationMs: measured.endedAt - measured.startedAt,
        frameMs: { p50: quantile(intervals, .5), p95: quantile(intervals, .95), p99: quantile(intervals, .99), max: Math.max(...intervals), over50: intervals.filter(value => value > 50).length },
        longTasks: { count: measured.longTasks.length, totalMs: measured.longTasks.reduce((total, task) => total + task.duration, 0), maxMs: Math.max(0, ...measured.longTasks.map(task => task.duration)) },
        selectionMs: measured.inputs[0].latency,
        responseEndToKnownActualUiMs: measured.catalogInteractiveAt - resource.responseEnd,
        scriptSeconds: metricDeltas.ScriptDuration, taskSeconds: metricDeltas.TaskDuration,
        wireBytes: resource.encodedBodySize, decodedBytes: resource.decodedBodySize,
      }
      // Save the completed timing interval before slower correctness/screenshots.
      fs.writeFileSync(path.join(output, `run-${run}-timing.json`), JSON.stringify({ summary, measured, actions, initialPins, health, graphics, metricDeltas }, null, 2) + '\n')
      const checked = await correctness(page, run)
      const server = await control('state')
      assert.equal(server.actualCompleted, 1)
      assert.equal(server.bootstrapCompleted, scenario === 'refresh' ? 1 : 0)
      assert(!server.events.some(event => ['unexpected', 'gate-error'].includes(event.type)))
      assert.deepEqual(unexpected, [])
      assert.deepEqual(errors, [])
      assert(requests.every(request => request.method === 'GET'))
      fs.writeFileSync(path.join(output, `run-${run}.json`), JSON.stringify({ summary, checked, requests, server, errors, unexpected }, null, 2) + '\n')
      summaries.push(summary)
      fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({
        complete: summaries.length === runs, requestedRuns: runs, runs: summaries,
        health, windowAcknowledgement, protocol: 'actual-arrival-v1', purpose,
        interpretation: scenario === 'cold'
          ? 'Cold first actual GET: drag/keyboard during arrival; city latency is explicitly AFTER initial city controls exist.'
          : 'First actual full payload during refresh into a two-job synthetic bootstrap; city Enter is queued 25ms after EOF control returns.',
        selectionEnd: 'Next native RAF after the expected visible city heading; paint opportunity proxy, not compositor presentation.',
        profiledRunsExcludedFromNativeAggregate: true,
      }, null, 2) + '\n')
      console.log(JSON.stringify(summary))
    } catch (error) {
      await page.screenshot({ path: path.join(output, `run-${run}-failure.png`) }).catch(() => {})
      const visibleState = await page.evaluate(() => ({
        heading: document.querySelector('.city-hero-caption h2')?.textContent ?? null,
        query: document.querySelector('input[aria-label="도시, 회사 또는 포지션 검색"]')?.value ?? null,
        cityRows: [...document.querySelectorAll('.city-row-main')].map(node => ({
          label: node.getAttribute('aria-label'), visible: node.getBoundingClientRect().width > 0,
        })),
        bodyText: document.body.innerText,
      })).catch(() => null)
      fs.writeFileSync(path.join(output, `run-${run}-failure.json`), JSON.stringify({
        error: String(error), requests, errors, unexpected, actions, visibleState,
        server: await control('state').catch(() => null),
      }, null, 2) + '\n')
      throw error
    } finally {
      await control('dispose').catch(() => {})
      await context.close()
    }
  }
} finally {
  await browser.close()
  auditFreeze(freeze)
}
