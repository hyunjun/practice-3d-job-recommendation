import type { BoardStatus, Catalog, Job } from '../../shared/types'
import { PUBLIC_TEST_CITIES } from './public-geography'
import { PUBLIC_PROTOCOL_COMPANIES, publicProtocolJob, publicSavedRecord } from './public-protocol'

/**
 * Stage75 authored wire fixtures for the negotiated waiting protocol
 * (docs/design/catalog-queued-progress.md). Every employer, posting, time and
 * failure text is invented and written out literally. Nothing here calls the
 * product's composer, scheduler or decoder; tests compare against these values.
 */
export type QueuedPhase = 'waiting-for-presence' | 'collecting'
export interface QueuedProgress {
  id: string
  revision: number
  phase: QueuedPhase
  total: number | null
  completed: number
  done: boolean
}
export interface QueuedSnapshot { catalog: Catalog; progress: QueuedProgress }
export interface QueuedUpdate {
  progress: QueuedProgress
  companyIds: string[]
  jobs: Job[]
  catalog: Omit<Catalog, 'companies' | 'cities' | 'jobs'>
}
export type QueuedCache = 'cold' | 'fresh'

export const QUEUED_ID = '00000000-0000-4000-8000-000000000075'
export const QUEUED_PREFER = 'respond-async, orbit-progress=queued'
export const QUEUED_FAILURE_MESSAGE = '공고 조회를 완료하지 못했어요. 다시 조회해 주세요.'
export const QUEUED_FAILURE_BODY = { error: QUEUED_FAILURE_MESSAGE }
export const QUEUED_WAITING_LABEL = '공고 조회 대기 중'
export const QUEUED_NOTE = '가상 75단계 메모 — 대기 중에도 보존 🌱'

export const QUEUED_TIMES = {
  /** The browser clock sits after every fixture time except the retry deadline. */
  browserNow: '2026-10-01T07:05:00.000Z',
  /** Aster's newly collected body in the cold scenario. */
  current: '2026-10-01T07:00:00.000Z',
  /** Cedar's public-list failure, accepted while the browser was waiting. */
  attempt: '2026-10-01T06:59:00.000Z',
  retry: '2026-10-01T07:09:00.000Z',
  /** Cached bodies for the fresh scenario, 25 minutes old at browserNow. */
  freshBody: '2026-10-01T06:40:00.000Z',
} as const
/** Literal ko-KR renderings in the pinned UTC timezone; no product formatter is used. */
export const QUEUED_TEXT = {
  attempt: '2026. 10. 01. 06:59', retry: '2026. 10. 01. 07:09', current: '2026. 10. 01. 07:00', freshBody: '2026. 10. 01. 06:40',
} as const

export const [QUEUED_ASTER, QUEUED_CEDAR] = PUBLIC_PROTOCOL_COMPANIES
export const QUEUED_COMPANIES = [QUEUED_ASTER, QUEUED_CEDAR]
const identity = (company: typeof QUEUED_ASTER) => ({ companyId: company.id, board: company.board!, provider: 'greenhouse' as const })
export const QUEUED_FAILURE_TEXT = 'Fictional public list 429'

export const QUEUED_ROWS = {
  asterCold: { ...identity(QUEUED_ASTER), status: 'ok', dataStatus: 'unavailable', total: 0, included: 0, lastSuccessAt: null, retryAt: null } as BoardStatus,
  cedarCold: { ...identity(QUEUED_CEDAR), status: 'ok', dataStatus: 'unavailable', total: 0, included: 0, lastSuccessAt: null, retryAt: null } as BoardStatus,
  /** Cedar's list failed while the browser waited and no body was ever collected. */
  cedarDeferred: {
    ...identity(QUEUED_CEDAR), status: 'error', dataStatus: 'unavailable', total: 0, included: 0,
    checkedAt: QUEUED_TIMES.attempt, lastSuccessAt: null, retryAt: QUEUED_TIMES.retry, message: QUEUED_FAILURE_TEXT,
  } as BoardStatus,
  asterPending: { ...identity(QUEUED_ASTER), status: 'pending', dataStatus: 'unavailable', total: 0, included: 0, lastSuccessAt: null, retryAt: null } as BoardStatus,
  asterCollected: {
    ...identity(QUEUED_ASTER), status: 'ok', dataStatus: 'fresh', total: 1, included: 1,
    checkedAt: QUEUED_TIMES.current, lastSuccessAt: QUEUED_TIMES.current, retryAt: null,
  } as BoardStatus,
  asterFresh: {
    ...identity(QUEUED_ASTER), status: 'ok', dataStatus: 'fresh', total: 1, included: 1,
    checkedAt: QUEUED_TIMES.freshBody, lastSuccessAt: QUEUED_TIMES.freshBody, retryAt: null,
  } as BoardStatus,
  cedarFresh: {
    ...identity(QUEUED_CEDAR), status: 'ok', dataStatus: 'fresh', total: 1, included: 1,
    checkedAt: QUEUED_TIMES.freshBody, lastSuccessAt: QUEUED_TIMES.freshBody, retryAt: null,
  } as BoardStatus,
  /** Cedar keeps its young body as dated retained content after its list check failed. */
  cedarDeferredRetained: {
    ...identity(QUEUED_CEDAR), status: 'error', dataStatus: 'stale', total: 1, included: 1,
    checkedAt: QUEUED_TIMES.attempt, lastSuccessAt: QUEUED_TIMES.freshBody, retryAt: QUEUED_TIMES.retry, message: QUEUED_FAILURE_TEXT,
  } as BoardStatus,
  /** Both companies eligible: Cedar scheduled and then collected in the same run. */
  cedarPending: { ...identity(QUEUED_CEDAR), status: 'pending', dataStatus: 'unavailable', total: 0, included: 0, lastSuccessAt: null, retryAt: null } as BoardStatus,
  cedarCollected: {
    ...identity(QUEUED_CEDAR), status: 'ok', dataStatus: 'fresh', total: 1, included: 1,
    checkedAt: QUEUED_TIMES.current, lastSuccessAt: QUEUED_TIMES.current, retryAt: null,
  } as BoardStatus,
} as const

export const QUEUED_TITLES = {
  aster: 'Backend Engineer — Aster Transit Ledger',
  cedar: 'Backend Engineer — Cedar Loom Studio',
} as const

export const queuedAsterJob = (fetchedAt: string = QUEUED_TIMES.current) => publicProtocolJob('ledger', { title: QUEUED_TITLES.aster, fetchedAt })
export const queuedCedarJob = (fetchedAt: string = QUEUED_TIMES.freshBody, stale = false) => publicProtocolJob('studio', {
  id: 'greenhouse-fixture-cedar-loom-studio', companyId: QUEUED_CEDAR.id, title: QUEUED_TITLES.cedar, fetchedAt, stale,
})
export const queuedSaved = () => [publicSavedRecord('saved', QUEUED_NOTE)].map(record => ({ ...record, status: 'applied' as const }))

function catalog(boards: BoardStatus[], jobs: Job[], metadata: Pick<Catalog, 'fetchedAt' | 'stale'> & Partial<Pick<Catalog, 'checkedAt' | 'refreshAfter'>>): Catalog {
  return structuredClone({
    source: 'public', ...metadata, companies: QUEUED_COMPANIES, cities: PUBLIC_TEST_CITIES, jobs, unmappedCount: 0, boards,
  })
}
const metadataOf = ({ companies: _companies, cities: _cities, jobs: _jobs, ...rest }: Catalog) => rest

export const waitingProgress = (revision = 0): QueuedProgress => ({
  id: QUEUED_ID, revision, phase: 'waiting-for-presence', total: null, completed: 0, done: false,
})
export const collectingProgress = (revision: number, total: number, completed: number, done: boolean): QueuedProgress => ({
  id: QUEUED_ID, revision, phase: 'collecting', total, completed, done,
})

/** The initial 202 while the saved-page list check is still active. No company is body-pending. */
export function queuedWaiting(cache: QueuedCache = 'cold'): QueuedSnapshot {
  return cache === 'cold'
    ? { catalog: catalog([QUEUED_ROWS.asterCold, QUEUED_ROWS.cedarCold], [], { fetchedAt: '', stale: false, refreshAfter: '2026-10-01T06:58:00.000Z' }), progress: waitingProgress() }
    : {
      catalog: catalog([QUEUED_ROWS.asterFresh, QUEUED_ROWS.cedarFresh], [queuedAsterJob(QUEUED_TIMES.freshBody), queuedCedarJob()], {
        fetchedAt: QUEUED_TIMES.freshBody, checkedAt: QUEUED_TIMES.freshBody, stale: false, refreshAfter: '2026-10-01T06:41:00.000Z',
      }),
      progress: waitingProgress(),
    }
}

/** Cedar's list failure was accepted; metadata only, still waiting, no body replaced or counted. */
export function queuedMetadata(cache: QueuedCache = 'cold', revision = 1): QueuedUpdate {
  const boards = cache === 'cold' ? [QUEUED_ROWS.asterCold, QUEUED_ROWS.cedarDeferred] : [QUEUED_ROWS.asterFresh, QUEUED_ROWS.cedarDeferredRetained]
  return {
    progress: waitingProgress(revision), companyIds: [], jobs: [],
    catalog: metadataOf(catalog(boards, [], {
      fetchedAt: cache === 'cold' ? '' : QUEUED_TIMES.freshBody, checkedAt: QUEUED_TIMES.attempt, stale: cache !== 'cold',
      refreshAfter: cache === 'cold' ? QUEUED_TIMES.attempt : '2026-10-01T06:41:00.000Z',
    })),
  }
}

/** Handoff in the cold scenario: one eligible company, Cedar excluded by its new deadline. */
export function queuedHandoff(revision = 2): QueuedUpdate {
  return {
    progress: collectingProgress(revision, 1, 0, false), companyIds: [], jobs: [],
    catalog: metadataOf(catalog([QUEUED_ROWS.asterPending, QUEUED_ROWS.cedarDeferred], [], {
      fetchedAt: '', checkedAt: QUEUED_TIMES.attempt, stale: false, refreshAfter: QUEUED_TIMES.attempt,
    })),
  }
}

/** Aster's body arrived; the run is complete with one actual body request. */
export function queuedCollected(revision = 3): QueuedUpdate {
  return {
    progress: collectingProgress(revision, 1, 1, true), companyIds: [QUEUED_ASTER.id], jobs: [queuedAsterJob()],
    catalog: metadataOf(catalog([QUEUED_ROWS.asterCollected, QUEUED_ROWS.cedarDeferred], [], {
      fetchedAt: QUEUED_TIMES.current, checkedAt: QUEUED_TIMES.current, stale: false, refreshAfter: '2026-10-01T07:01:00.000Z',
    })),
  }
}

/**
 * Cold scenario where both lists succeeded: the client first sees the run with Aster already
 * collected and Cedar still pending. A valid direct transition from waiting.
 */
export function queuedPartial(revision = 2): QueuedUpdate {
  return {
    progress: collectingProgress(revision, 2, 1, false), companyIds: [QUEUED_ASTER.id], jobs: [queuedAsterJob()],
    catalog: metadataOf(catalog([QUEUED_ROWS.asterCollected, QUEUED_ROWS.cedarPending], [], {
      fetchedAt: QUEUED_TIMES.current, checkedAt: QUEUED_TIMES.current, stale: false, refreshAfter: '2026-10-01T07:01:00.000Z',
    })),
  }
}

/** Completion of the two-company run after `queuedPartial`. */
export function queuedBothCollected(revision = 3): QueuedUpdate {
  return {
    progress: collectingProgress(revision, 2, 2, true), companyIds: [QUEUED_CEDAR.id], jobs: [queuedCedarJob(QUEUED_TIMES.current)],
    catalog: metadataOf(catalog([QUEUED_ROWS.asterCollected, QUEUED_ROWS.cedarCollected], [], {
      fetchedAt: QUEUED_TIMES.current, checkedAt: QUEUED_TIMES.current, stale: false, refreshAfter: '2026-10-01T07:01:00.000Z',
    })),
  }
}

/** Fresh scenario: after Cedar's list failure nothing is eligible, so the run ends with zero body work. */
export function queuedZeroWork(revision = 2): QueuedUpdate {
  return {
    progress: collectingProgress(revision, 0, 0, true), companyIds: [], jobs: [],
    catalog: metadataOf(catalog([QUEUED_ROWS.asterFresh, QUEUED_ROWS.cedarDeferredRetained], [], {
      fetchedAt: QUEUED_TIMES.freshBody, checkedAt: QUEUED_TIMES.attempt, stale: true, refreshAfter: '2026-10-01T06:41:00.000Z',
    })),
  }
}

/** A complete ordinary catalog for a manual retry after the fixed operation failure. */
export function queuedRecoveredCatalog(): Catalog {
  const cedar = { ...QUEUED_ROWS.cedarFresh, checkedAt: QUEUED_TIMES.current, lastSuccessAt: QUEUED_TIMES.current }
  return catalog([QUEUED_ROWS.asterCollected, cedar], [queuedAsterJob(), queuedCedarJob(QUEUED_TIMES.current)], {
    fetchedAt: QUEUED_TIMES.current, checkedAt: QUEUED_TIMES.current, stale: false, refreshAfter: '2026-10-01T07:01:00.000Z',
  })
}
