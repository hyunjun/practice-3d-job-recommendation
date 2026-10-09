import type { Page, Request } from '@playwright/test'
import { buildPublication } from '../../../../server/publication-build'
import type { BuiltPublication } from '../../../../server/publication-build'
import type { CatalogPublicationCapture } from '../../../../server/catalog-service'
import type { PublicationHead } from '../../../../shared/publication'
import type { Company, Job } from '../../../../shared/types'
import { FICTIONAL_COMMIT, publicationHarness } from '../../../fixtures/publication'
import type { PublicationGeneration } from '../../../fixtures/publication'
import { PUBLIC_PROTOCOL_COMPANIES, publicProtocolCatalog } from '../../../fixtures/public-protocol'
import { contractClient, freezeClock, wipeStore } from '../../helpers/worker-http'

/**
 * Deterministic synthetic publication for the scheduled-build UI: the same three
 * fictional employers and 29 postings across 22 cities that the default E2E suite
 * serves through its Express fixture, collected by the real Node collector with
 * injected fetchers and published to the local Worker through the real client.
 * The Worker clock is frozen at UI_NOW and the browser clock is fixed to match,
 * so freshness wording is deterministic.
 *
 * UI-local input (AUI82-7): the two Mosaic Clinic postings carry the Mosaic
 * company id explicitly here, whatever the shared fixture's defaults are, and the
 * spec asserts the authored input has postings for all three employers before
 * any browser assertion relies on the three-company count.
 */
export const UI_RUN = '2026-10-03T06:00:00.000Z'
export const UI_NOW = '2026-10-03T06:05:00.000Z'
export const UI_COMPANIES: Company[] = PUBLIC_PROTOCOL_COMPANIES
const MOSAIC = 'fixture-mosaic-clinic'
export const UI_JOBS: Job[] = publicProtocolCatalog({ fetchedAt: UI_RUN }).jobs
  .map(job => job.id.startsWith(`greenhouse-${MOSAIC}-`) ? { ...job, companyId: MOSAIC } : job)
export const UI_LONDON_TITLE = 'Backend Engineer — Aster Transit London'
export const UI_LONDON_JOB = UI_JOBS.find(job => job.title === UI_LONDON_TITLE)!
/** Literal facts of the authored input that the browser assertions rely on. */
export const UI_INPUT = { jobs: 29, employers: 3, cities: 22, unmappedTitle: 'Backend Engineer — Aster Transit Oxford' } as const
/** The visibly changed later publication (AUI82-2/MUI82-3): the London title changes and the unmapped Oxford posting disappears. */
export const UI_LONDON_TITLE_CHANGED = 'Staff Backend Engineer — Aster Transit London (갱신)'
export const UI_CHANGED_JOBS: Job[] = UI_JOBS
  .filter(job => job.title !== UI_INPUT.unmappedTitle)
  .map(job => job.title === UI_LONDON_TITLE ? { ...job, title: UI_LONDON_TITLE_CHANGED } : job)
export const UI_CHANGED_INPUT = { jobs: 28, employers: 3, cities: 22 } as const

export async function uiCapture(at = UI_RUN, checkpointFrom?: CatalogPublicationCapture, jobs: Job[] = UI_JOBS): Promise<CatalogPublicationCapture> {
  const harness = publicationHarness({ companies: UI_COMPANIES, at })
  harness.fetchBoard.mockImplementation(async (company, fetchedAt) => {
    const selected = jobs.filter(job => job.companyId === company.id).map(job => ({ ...job, fetchedAt }))
    // The board result must declare its unmapped postings truthfully (UI remedy candidate 01 §1): the real
    // collector's snapshot rule rejects a board whose declared count is below the postings it returns with no
    // city and a non-remote work mode, and the authored initial input keeps one such posting (UI_INPUT.unmappedTitle).
    // Same literal rule as the shared fixture's catalog; no product function computes it.
    const unmapped = selected.filter(job => !job.cityIds.length && job.workMode !== 'remote').length
    return { jobs: selected, total: selected.length, unmappedCount: unmapped, publishedIds: selected.map(job => job.id) }
  })
  harness.fetchPresence.mockImplementation(async company => {
    const selected = jobs.filter(job => job.companyId === company.id)
    return { total: selected.length, publishedIds: selected.map(job => job.id) }
  })
  const { capture } = await harness.run(checkpointFrom && {
    boards: structuredClone(checkpointFrom.boards), presence: structuredClone(checkpointFrom.presences),
    observations: structuredClone(checkpointFrom.observationCheckpoint),
  })
  return capture
}

export async function publishUi(origin: string, capture: CatalogPublicationCapture, generation: PublicationGeneration, parent: PublicationHead | null = null) {
  const built: BuiltPublication = buildPublication(capture, FICTIONAL_COMMIT, parent, generation)
  const head = await contractClient(origin).publish(built)
  return { built, head }
}

/** Fresh store, frozen Worker clock at `now`, and the browser clock fixed to the same instant. */
export async function resetScheduledWorld(origin: string, page: Page, now = UI_NOW) {
  await wipeStore(origin)
  await freezeClock(origin, now)
  await page.clock.setFixedTime(new Date(now))
}

export interface ApiObservation { method: string; path: string; status: number | null; generation: string | null; body: string | null; failure: string | null; finished: boolean }
/**
 * Every /api/* request the page makes, with its wire status and X-Orbit-Generation
 * header. Entries are keyed by the Playwright Request object (AUI82-6/MUI82-4), so
 * two outstanding same-URL requests keep their own records; a failed request keeps
 * its failure text and never a synthesised status. `finished` is the raw
 * requestfinished evidence of the same Request (observation disposal design 03):
 * status, failure text and finish are recorded independently and never normalised
 * against each other, so a record that is neither finished nor failed is still
 * pending, and a finish next to a failure stays visible as the contradiction it is.
 */
export function observeApi(page: Page): ApiObservation[] {
  const observed: ApiObservation[] = []
  const pending = new Map<Request, ApiObservation>()
  page.on('request', request => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) return
    const entry: ApiObservation = { method: request.method(), path: url.pathname + url.search, status: null, generation: null, body: request.postData(), failure: null, finished: false }
    observed.push(entry)
    pending.set(request, entry)
  })
  page.on('response', response => {
    const entry = pending.get(response.request())
    if (!entry) return
    entry.status = response.status()
    entry.generation = response.headers()['x-orbit-generation'] ?? null
  })
  page.on('requestfinished', request => {
    const entry = pending.get(request)
    if (entry) entry.finished = true
  })
  page.on('requestfailed', request => {
    const entry = pending.get(request)
    if (entry) entry.failure = request.failure()?.errorText ?? 'request failed'
  })
  return observed
}
