import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { perf, oracle, shaFile, quantile } from './protocol.mjs'

// Reporting only: run after the complete native cohorts and owned-process cleanup.
const read = relative => JSON.parse(fs.readFileSync(path.join(perf, relative), 'utf8'))
const qualification = read('metric-v2-qualification.json')
assert.equal(qualification.qualifiedCount, 4)
const cleanup = read('final-v2-cleanup.json')
assert.equal(cleanup.ownedServersStopped, true)
assert.equal(cleanup.ownedBrowsersClosed, true)
const sourceAudit = read('final-v2-source-audit.json')
assert.equal(sourceAudit.allMatched, true)
const frozen = read('native-protocol-freeze-v2/manifest.json')
for (const [file, hash] of Object.entries(frozen.harness))
  assert.equal(shaFile(path.join(perf, file)), hash, `Frozen metric-v2 harness changed: ${file}`)

const inventory = [
  ['actual-cold', '66', 'before66-actual-cold-v2-01'],
  ['actual-cold', '68', 'after68-actual-cold-v2-01'],
  ['actual-refresh', '68', 'after68-actual-refresh-v2-01'],
  ['actual-refresh', '66', 'before66-actual-refresh-v2-01'],
  ['synthetic-native-v1', '66', 'before66-synthetic-v1-metric-v2-01'],
  ['synthetic-native-v1', '68', 'after68-synthetic-v1-metric-v2-01'],
]
const range = values => {
  assert(values.length > 0 && values.every(Number.isFinite))
  return { median: quantile(values, .5), min: Math.min(...values), max: Math.max(...values), values }
}
const groups = inventory.map(([scenario, stage, label]) => {
  const actual = scenario.startsWith('actual-')
  const result = read(`runs/${label}/summary.json`)
  assert.equal(result.complete, true, label)
  assert.equal(result.requestedRuns, 5, label)
  assert.equal(result.runs.length, 5, label)
  const raw = [], records = []
  for (let run = 1; run <= 5; run++) {
    const record = read(`runs/${label}/run-${run}.json`)
    const timing = actual ? read(`runs/${label}/run-${run}-timing.json`) : record
    const summary = record.summary
    assert.equal(summary.metricVersion, 2)
    assert.equal(summary.interactionVersion, 1)
    assert.equal(summary.profiling, false)
    assert.equal(summary.run, run)
    assert.deepEqual(summary, result.runs[run - 1])
    assert.deepEqual(record.errors, [])
    assert.deepEqual(record.unexpected, [])
    assert.equal(timing.measured.metricVersion, 2)
    assert.equal(timing.measured.pending.length, 0)
    assert(timing.measured.frames.length > 100)
    assert(!timing.measured.visibility.some(item => item.hidden))
    const inputs = actual ? timing.measured.inputs : timing.measured.latencies
    assert.equal(inputs.length, actual ? 1 : 3)
    for (const input of inputs) {
      assert.equal(input.trusted, true)
      assert(input.domObservedAt >= input.deliveredAt)
      assert(input.paintOpportunityAt >= input.domObservedAt)
      assert.equal(input.latency, input.paintOpportunityAt - input.at)
      assert(Number.isFinite(input.domSuppliedFrameTimestamp))
      assert(Number.isFinite(input.paintSuppliedFrameTimestamp))
    }
    if (actual) {
      assert.equal(summary.purpose, 'native')
      assert.equal(summary.aggregateEligible, true)
      assert.equal(summary.wireBytes, 5272430)
      assert.equal(summary.decodedBytes, 59894550)
      assert.deepEqual(record.checked.coverage, ['22', '124', '6,756'])
      assert.deepEqual(record.checked.landmarks.map(item => item.id), oracle.landmarks.map(item => item.id))
      assert.equal(record.server.actualCompleted, 1)
      assert.equal(record.server.bootstrapCompleted, scenario === 'actual-refresh' ? 1 : 0)
      assert(!record.server.events.some(event => ['unexpected', 'gate-error'].includes(event.type)))
      assert(record.requests.every(request => request.method === 'GET'))
      assert.equal(timing.actions.filter(action => action.type === 'native-drag').length, 2)
      assert(timing.actions.filter(action => action.type === 'native-drag').every(action =>
        action.moves === 120 && action.scheduledHz === 60 && action.amplitude === 0.19))
      assert(timing.measured.catalogPaintOpportunityAt >= timing.measured.catalogDomObservedAt)
    } else {
      assert.equal(summary.throttle, 1)
      assert.equal(record.protocol.dateOnlyFrozen, true)
      assert.equal(record.protocol.nativeRAF, true)
      assert.equal(record.protocol.initialJobs, 6600)
      assert.deepEqual(record.protocol.streamJobs, [6780, 6780])
      assert.deepEqual(record.actions.map(action => [action.city, action.companyCount]),
        [['런던', 4], ['암스테르담', 4], ['뉴욕', 3]])
      assert(record.traffic.every(request => request.method === 'GET' && request.body === null))
    }
    raw.push(timing)
    records.push({ run, file: `runs/${label}/run-${run}.json`,
      sha256: shaFile(path.join(perf, 'runs', label, `run-${run}.json`)),
      ...(actual ? { timingFile: `runs/${label}/run-${run}-timing.json`,
        timingSha256: shaFile(path.join(perf, 'runs', label, `run-${run}-timing.json`)) } : {}) })
  }
  const summaries = result.runs
  const metric = getter => range(summaries.map(getter))
  const drivers = actual ? {
    keyboardDispatchCompletionMs: range(raw.map(item =>
      item.actions.find(action => action.type.startsWith('queued-')).dispatchCompletionMs)),
    queuedInputAfterEofControlMs: range(raw.map(item =>
      item.actions.find(action => action.type.startsWith('queued-')).afterEofControlMs)),
    perRunMaximumDragDispatchLagMs: range(raw.map(item =>
      Math.max(...item.actions.filter(action => action.type === 'native-drag').map(action => action.dispatchLagMax)))),
  } : {
    perRunMaximumDragDispatchLagMs: range(raw.map(item =>
      Math.max(...item.actions.map(action => action.inputLagMax)))),
  }
  return {
    scenario, stage, label, completeRuns: 5, metricVersion: 2, interactionVersion: 1,
    browser: actual ? result.browser : raw[0].protocol.browser,
    sourceManifestSha256: raw[0].health.manifestSha256,
    graphics: raw[0].graphics,
    durationMs: metric(run => run.durationMs),
    frameP95Ms: metric(run => run.frameMs.p95),
    frameMaxMs: metric(run => run.frameMs.max),
    frameOver50Count: metric(run => run.frameMs.over50),
    longTaskTotalMs: metric(run => run.longTasks.totalMs),
    longTaskMaxMs: metric(run => run.longTasks.maxMs),
    longTaskCount: metric(run => run.longTasks.count),
    selectionMs: metric(run => actual ? run.selectionMs : run.selectionMs.median),
    ...(actual ? {
      responseEndToCatalogDomObservedMs: metric(run => run.responseEndToCatalogDomObservedMs),
      responseEndToCatalogPaintOpportunityMs: metric(run => run.responseEndToCatalogPaintOpportunityMs),
      catalogDomExecutionMinusSuppliedFrameMs: range(raw.map(item =>
        item.measured.catalogDomObservedAt - item.measured.catalogDomSuppliedFrameTimestamp)),
    } : {
      selectionPerCityMs: Object.fromEntries(['런던', '암스테르담', '뉴욕'].map((city, phase) => [
        city, range(raw.map(item => item.measured.latencies[phase].latency)),
      ])),
    }),
    scriptSeconds: metric(run => run.scriptSeconds),
    taskSeconds: metric(run => run.taskSeconds),
    drivers, records,
  }
})
assert.equal(groups.reduce((sum, group) => sum + group.completeRuns, 0), 30)
assert.equal(new Set(groups.map(group => group.browser)).size, 1)
const metrics = ['longTaskTotalMs', 'longTaskMaxMs', 'frameP95Ms', 'frameMaxMs', 'selectionMs',
  'responseEndToCatalogDomObservedMs', 'responseEndToCatalogPaintOpportunityMs']
const comparisons = ['actual-cold', 'actual-refresh', 'synthetic-native-v1'].map(scenario => {
  const before = groups.find(group => group.scenario === scenario && group.stage === '66')
  const after = groups.find(group => group.scenario === scenario && group.stage === '68')
  return { scenario, before: before.label, after: after.label,
    medianChanges: Object.fromEntries(metrics.filter(metric => before[metric]).map(metric => {
      const beforeMedian = before[metric].median, afterMedian = after[metric].median
      return [metric, { before: beforeMedian, after: afterMedian,
        difference: afterMedian - beforeMedian,
        percentChange: beforeMedian ? (afterMedian / beforeMedian - 1) * 100 : null }]
    })) }
})
const limitations = [
  'Stage66 to combined Stage68 includes both Stage67 worker processing and Stage68 presentation scheduling; this comparison does not isolate either stage.',
  'Five fresh browser contexts per cohort in one headless installed-Chrome process per cohort. Build order is counterbalanced by scenario (cold66->68, refresh68->66), not randomized per trial; descriptive medians/ranges, not inferential significance.',
  'The actual cold scenario is the first catalog payload after the app and WebGL globe have already warmed. Startup, provider collection, DNS and Internet latency are excluded.',
  'Actual refresh replaces a two-job synthetic bootstrap with the first full actual snapshot; it does not represent refreshing an already loaded 60MB actual catalog.',
  'Actual payload: unchanged authorized 59,894,550 decoded bytes / 5,272,430 Brotli bytes, 24 paced body chunks at50ms with a held final16 encoded bytes. Loopback and controlled gates, no upstream calls.',
  'Only Date is fixed. RAF, performance.now(), timers and trusted input events are native, with CPU rate1 and no profiler. Long tasks cover the page main thread, not worker CPU or total system work.',
  'Frame intervals use the native RAF supplied timestamps. Actual DOM observation and the following RAF callback execution use performance.now(); that next callback is a paint-opportunity proxy, not a compositor presentation timestamp.',
  'Cold city selection occurs after initial city controls exist. Refresh Enter is queued25ms after EOF control; trusted event-to-visible latency and host command completion are recorded separately. Neither is a hardware input latency measurement.',
  'The synthetic workload has realistic job cardinality but thin descriptions and uses routed public responses. It is a separate native-v1 interaction workload, with metric-v2 endpoints; do not pool it with the actual-payload scenario.',
  'For synthetic selection, the main comparison is the median of the five per-run medians of three city selections. Per-city medians/ranges are also retained. Frame p95 can hide rare multi-second stalls; per-run maxima and main-thread long-task totals are reported.',
  'Original v1 evidence remains unchanged. Its supplied-RAF DOM/selection endpoints are invalid for readiness or latency conclusions and are excluded from this metric-v2 aggregate; the original frame-interval/long-task definitions remain valid.',
]
const output = {
  generatedAt: new Date().toISOString(), metricVersion: 2, interactionVersion: 1,
  acceptedNativeRuns: 30, actualNativeRuns: 20, syntheticNativeRuns: 10,
  qualificationRuns: 4, qualificationExcludedFromAggregate: true,
  v1Excluded: read('metric-v1-retirement.json'),
  groups, comparisons, limitations, sourceAudit, cleanup,
  harnessManifestSha256: shaFile(path.join(perf, 'native-protocol-freeze-v2/manifest.json')),
  commands: [
    'GLOBE_QA_WINDOW=<Main grant 2026-09-27T09:21Z> node .local/research/67-catalog-worker/performance/run-cohorts-v2.mjs actual-v2-qualification',
    'GLOBE_QA_WINDOW=<same grant> node .local/research/67-catalog-worker/performance/run-cohorts-v2.mjs actual-v2-native',
    'GLOBE_QA_WINDOW=<same grant> node .local/research/67-catalog-worker/performance/run-cohorts-v2.mjs synthetic-v2-native',
    'node .local/research/67-catalog-worker/performance/aggregate-v2.mjs',
  ],
}
fs.writeFileSync(path.join(perf, 'comparison-v2.json'), JSON.stringify(output, null, 2) + '\n', { flag: 'wx' })
const format = value => value.toFixed(1)
const cell = metric => `${format(metric.median)} [${format(metric.min)}–${format(metric.max)}]`
const rows = groups.map(group =>
  `| ${group.scenario} | ${group.stage} | ${cell(group.longTaskTotalMs)} | ${cell(group.frameMaxMs)} | ${cell(group.selectionMs)} |`)
const arrivalRows = groups.filter(group => group.scenario.startsWith('actual-')).map(group =>
  `| ${group.scenario} | ${group.stage} | ${cell(group.responseEndToCatalogDomObservedMs)} | ${cell(group.responseEndToCatalogPaintOpportunityMs)} |`)
const syntheticRows = groups.filter(group => group.scenario === 'synthetic-native-v1').flatMap(group =>
  Object.entries(group.selectionPerCityMs).map(([city, value]) => `| ${group.stage} | ${city} | ${cell(value)} |`))
const report = [
  '# Stage66 → combined Stage68 native performance, metric v2',
  '',
  `Completed ${output.acceptedNativeRuns}/30 native samples plus4/4 separate qualifications. All original literal UI/data checks passed; no failed/partial/qualification/v1 run enters the v2 aggregate. CPU-sensitive window ended: ${cleanup.cpuWindowEndedAt}.`,
  '',
  'Values below are milliseconds: median of five runs [minimum–maximum]. A long-task total is the sum within one measured interval; the frame maximum is the largest RAF interval within that run.',
  '',
  '| Scenario | Stage | Main-thread long-task total | Maximum RAF interval | City input → next RAF execution |',
  '|---|---:|---:|---:|---:|',
  ...rows,
  '',
  'Actual catalog availability is measured separately from input responsiveness. Both clocks below begin at the full HTTP resource responseEnd. DOM observation and the next callback execution are actual performance.now() readings.',
  '',
  '| Scenario | Stage | Response end → catalog DOM observed | Response end → next RAF execution |',
  '|---|---:|---:|---:|',
  ...arrivalRows,
  '',
  'Synthetic native-v1 interactions, metric-v2 city latency:',
  '',
  '| Stage | City | Input → next RAF execution |',
  '|---:|---|---:|',
  ...syntheticRows,
  '',
  'The corrected v2 clocks replace the stale supplied-RAF endpoint definition. The original Stage66 cold example used7014.1ms as catalogInteractiveAt despite an earlier callback blocking7001.4–9958.4ms. No readiness conclusion from that v1 marker is retained. See metric-v1-retirement.json and all preserved original run directories.',
  '',
  'Limits:',
  '',
  ...limitations.map(limit => `- ${limit}`),
  '',
  `Browser: ${groups[0].browser}. Source/build/test/artifact SHA audit: final-v2-source-audit.json; cleanup: final-v2-cleanup.json. Actual source SHA256: ${oracle.catalogSha256}. Full raw intervals, long tasks, corrected endpoint clocks, supplied frame timestamps, trusted input delivery times, host dispatch lags, screenshots and literal landmark checks are retained under runs/.`,
  '',
  'Commands and exact cohort run/hash inventory are recorded in comparison-v2.json and *-v2-*-execution.jsonl. New public tests and functional results are documented in the Stage68 handoff; this measurement phase changed only ignored private QA files.',
  '',
]
fs.writeFileSync(path.join(perf, 'comparison-v2.md'), report.join('\n'), { flag: 'wx' })
console.log(JSON.stringify({ acceptedNativeRuns: 30, qualificationRuns: 4, comparisons, files: ['comparison-v2.json', 'comparison-v2.md'] }, null, 2))
