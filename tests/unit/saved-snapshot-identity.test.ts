import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Job, SavedJob } from '../../shared/types'
import { SavedController } from '../../src/lib/saved-controller'
import type { SavedStore, SavedStoreSnapshot } from '../../src/lib/saved-store'

function fictionalRecord(id = 'greenhouse-fable-weather-01'): SavedJob {
  const job: Job = {
    id, companyId: 'fable-weather', title: 'Fable Weather · Backend Engineer',
    role: 'backend', cityIds: ['london'], locationLabel: 'London, UK',
    workMode: 'hybrid', employment: 'fulltime', minExperience: 3, skills: ['Python'],
    salary: null, visa: 'unknown', remoteCountries: [], remoteWorldwide: false,
    remoteScopeUnknown: false, source: 'greenhouse',
    description: 'Build fictional weather tools with Python. Core hours are 10:00–14:00 UTC.',
    requirements: ['Three years of Python experience.'],
    url: 'https://example.org/fable-weather/original',
    updatedAt: null, fetchedAt: '2026-09-26T07:00:00.000Z',
    evidence: { workMode: { source: 'board', text: 'Two days per week in the office.' } },
    workTimeRequirements: {
      version: 1, rules: [{
        kind: 'core-hours', level: 'required', statement: '10:00–14:00 UTC',
        evidence: { source: 'description', text: 'Core hours are 10:00–14:00 UTC.' },
      }],
    },
  }
  return {
    job,
    company: {
      id: 'fable-weather', name: 'Fable Weather', initials: 'FW', color: '#84dba6',
      industry: 'Fictional weather software', provider: 'greenhouse', board: 'fable-weather',
      careerUrl: 'https://example.org/fable-weather/careers',
    },
    savedAt: '2026-09-25T08:00:00.000Z', status: 'saved', note: 'Original fictional note',
  }
}

const controllers: SavedController[] = []
afterEach(() => { controllers.splice(0).forEach(controller => controller.stop()) })

// Script valid store replies, each cloned like an IndexedDB decode. Expected
// behavior is asserted below with literal values, not this helper's output.
function scriptedStore(initial: SavedJob[]) {
  let nextRead = initial
  const read = vi.fn<SavedStore['read']>().mockImplementation(async (): Promise<SavedStoreSnapshot> => ({
    records: structuredClone(nextRead), recovery: [], unreadableIds: [], occupied: nextRead.length,
  }))
  const apply = vi.fn<SavedStore['apply']>()
  const importRecords = vi.fn<SavedStore['importRecords']>().mockResolvedValue(undefined)
  const store: SavedStore = {
    read, apply, importRecords, discardRecovery: vi.fn().mockResolvedValue(undefined), close: vi.fn(),
  }
  const controller = new SavedController(async () => store)
  controllers.push(controller)
  return { controller, read, apply, setRead: (records: SavedJob[]) => { nextRead = records } }
}

async function ready(controller: SavedController) {
  await vi.waitFor(() => expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', pending: 0, error: null }))
}

describe('saved snapshot identity without stale content', () => {
  it('retains an unchanged job through every publication of note and status commits while accepting new record fields', async () => {
    const fixture = fictionalRecord()
    const { controller, apply } = scriptedStore([fixture])
    await controller.start()
    const before = controller.getSnapshot().records[0]
    const published: SavedJob[] = []
    const unsubscribe = controller.subscribe(() => { published.push(controller.getSnapshot().records[0]) })
    apply.mockResolvedValueOnce({
      id: 'greenhouse-fable-weather-01', order: 1,
      record: structuredClone({ ...fixture, note: 'Committed note with the same snapshot' }),
    })
    expect(controller.change({
      kind: 'update', id: 'greenhouse-fable-weather-01', patch: { note: 'Committed note with the same snapshot' },
    })).toEqual({ accepted: true })
    await ready(controller)
    apply.mockResolvedValueOnce({
      id: 'greenhouse-fable-weather-01', order: 1,
      record: structuredClone({ ...fixture, note: 'Committed note with the same snapshot', status: 'applied' }),
    })
    expect(controller.change({
      kind: 'update', id: 'greenhouse-fable-weather-01', patch: { status: 'applied' },
    })).toEqual({ accepted: true })
    await ready(controller)
    unsubscribe()
    expect(published.length).toBeGreaterThan(0)
    for (const record of published) expect(record.job).toBe(before.job)
    const current = controller.getSnapshot().records[0]
    expect(current).not.toBe(before)
    expect(current).toMatchObject({
      job: { id: 'greenhouse-fable-weather-01', title: 'Fable Weather · Backend Engineer' },
      note: 'Committed note with the same snapshot', status: 'applied', savedAt: '2026-09-25T08:00:00.000Z',
    })
    expect(before.note).toBe('Original fictional note')
    expect(before.status).toBe('saved')
  })

  it('retains unchanged job objects after other-tab reads while publishing incoming notes and application states', async () => {
    const first = fictionalRecord()
    const second = fictionalRecord('greenhouse-fable-weather-02')
    const { controller, setRead } = scriptedStore([first, second])
    await controller.start()
    const before = controller.getSnapshot().records
    setRead([
      { ...first, note: 'Other tab note 01', status: 'applied' },
      { ...second, note: 'Other tab note 02', savedAt: '2026-09-26T06:00:00.000Z' },
    ])
    await controller.refresh()
    const current = controller.getSnapshot().records
    expect(current.map(record => record.job.id)).toEqual(['greenhouse-fable-weather-01', 'greenhouse-fable-weather-02'])
    expect(current[0].job).toBe(before[0].job)
    expect(current[1].job).toBe(before[1].job)
    expect(current[0]).toMatchObject({ note: 'Other tab note 01', status: 'applied', savedAt: '2026-09-25T08:00:00.000Z' })
    expect(current[1]).toMatchObject({ note: 'Other tab note 02', status: 'saved', savedAt: '2026-09-26T06:00:00.000Z' })
  })

  it('keeps new same-ID title, body, URL and nested evidence distinct on a committed update', async () => {
    const fixture = fictionalRecord()
    const { controller, apply } = scriptedStore([fixture])
    await controller.start()
    const before = controller.getSnapshot().records[0].job
    const incoming = structuredClone(fixture)
    incoming.job.title = 'Fable Weather · Revised Backend Engineer'
    incoming.job.description = 'Revised fictional weather source. Core hours are 12:00–16:00 UTC.'
    incoming.job.url = 'https://example.org/fable-weather/revised'
    incoming.job.workTimeRequirements = {
      version: 1, rules: [{
        kind: 'core-hours', level: 'required', statement: '12:00–16:00 UTC',
        evidence: { source: 'description', text: 'Core hours are 12:00–16:00 UTC.' },
      }],
    }
    incoming.note = 'Merge my note with the newer source snapshot'
    incoming.status = 'applied'
    apply.mockResolvedValueOnce({ id: 'greenhouse-fable-weather-01', order: 1, record: incoming })
    controller.change({
      kind: 'update', id: 'greenhouse-fable-weather-01', patch: { note: 'Merge my note with the newer source snapshot' },
    })
    await ready(controller)
    const current = controller.getSnapshot().records[0]
    expect(current.job).not.toBe(before)
    expect(current.job).toMatchObject({
      id: 'greenhouse-fable-weather-01', title: 'Fable Weather · Revised Backend Engineer',
      description: 'Revised fictional weather source. Core hours are 12:00–16:00 UTC.',
      url: 'https://example.org/fable-weather/revised',
      workTimeRequirements: {
        version: 1, rules: [{
          kind: 'core-hours', level: 'required', statement: '12:00–16:00 UTC',
          evidence: { source: 'description', text: 'Core hours are 12:00–16:00 UTC.' },
        }],
      },
    })
    expect(current).toMatchObject({ note: 'Merge my note with the newer source snapshot', status: 'applied' })
    expect(before.title).toBe('Fable Weather · Backend Engineer')
    expect(before.description).toBe('Build fictional weather tools with Python. Core hours are 10:00–14:00 UTC.')
    expect(before.workTimeRequirements?.rules[0].statement).toBe('10:00–14:00 UTC')
  })

  it('does not hide a nested evidence-only change behind identical ID, title, body and URL on refresh', async () => {
    const fixture = fictionalRecord()
    const { controller, setRead } = scriptedStore([fixture])
    await controller.start()
    const before = controller.getSnapshot().records[0].job
    const incoming = structuredClone(fixture)
    incoming.job.evidence!.workMode!.text = 'Three days per week in the office.'
    setRead([incoming])
    await controller.refresh()
    const current = controller.getSnapshot().records[0].job
    expect(current).not.toBe(before)
    expect(current).toMatchObject({
      id: 'greenhouse-fable-weather-01', title: 'Fable Weather · Backend Engineer',
      description: 'Build fictional weather tools with Python. Core hours are 10:00–14:00 UTC.',
      url: 'https://example.org/fable-weather/original',
      evidence: { workMode: { source: 'board', text: 'Three days per week in the office.' } },
    })
    expect(before.evidence?.workMode?.text).toBe('Two days per week in the office.')
  })

  it('publishes the incoming company board and record metadata even when its job content is unchanged', async () => {
    const fixture = fictionalRecord()
    const { controller, setRead } = scriptedStore([fixture])
    await controller.start()
    const before = controller.getSnapshot().records[0]
    const incoming = structuredClone(fixture)
    incoming.company.name = 'Fable Weather New Board'
    incoming.company.board = 'fable-weather-moved'
    incoming.company.careerUrl = 'https://example.org/fable-weather/new-board'
    incoming.note = 'Other tab record from the new board'
    incoming.status = 'applied'
    setRead([incoming])
    await controller.refresh()
    const current = controller.getSnapshot().records[0]
    expect(current.company).not.toBe(before.company)
    expect(current).toMatchObject({
      company: {
        id: 'fable-weather', name: 'Fable Weather New Board', provider: 'greenhouse',
        board: 'fable-weather-moved', careerUrl: 'https://example.org/fable-weather/new-board',
      },
      note: 'Other tab record from the new board', status: 'applied',
    })
    expect(before.company.board).toBe('fable-weather')
    expect(before.note).toBe('Original fictional note')
  })

  it('preserves only surviving identical jobs across external additions/removals and honors the incoming order', async () => {
    const first = fictionalRecord()
    const second = fictionalRecord('greenhouse-fable-weather-02')
    const { controller, setRead } = scriptedStore([first, second])
    await controller.start()
    const before = controller.getSnapshot().records
    setRead([fictionalRecord('greenhouse-fable-weather-03'), { ...second, note: 'Surviving second record' }])
    await controller.refresh()
    const current = controller.getSnapshot().records
    expect(current.map(record => record.job.id)).toEqual(['greenhouse-fable-weather-03', 'greenhouse-fable-weather-02'])
    expect(current[0].job).not.toBe(before[0].job)
    expect(current[0].job).not.toBe(before[1].job)
    expect(current[1].job).toBe(before[1].job)
    expect(current[1].note).toBe('Surviving second record')
    expect(current.some(record => record.job.id === 'greenhouse-fable-weather-01')).toBe(false)
  })

  it('keeps the identical job after an import while accepting changed note/status/date fields', async () => {
    const fixture = fictionalRecord()
    const { controller, setRead } = scriptedStore([fixture])
    await controller.start()
    const before = controller.getSnapshot().records[0]
    const incoming: SavedJob = {
      ...structuredClone(fixture), note: 'Imported record with the same source snapshot',
      status: 'applied', savedAt: '2026-09-26T08:00:00.000Z',
    }
    setRead([incoming])
    expect(await controller.importRecords({ items: [{ expected: fixture, record: incoming }] })).toEqual({ ok: true })
    const current = controller.getSnapshot().records[0]
    expect(current.job).toBe(before.job)
    expect(current).toMatchObject({
      note: 'Imported record with the same source snapshot', status: 'applied',
      savedAt: '2026-09-26T08:00:00.000Z',
    })
  })
})
