import { ageCatalog, catalogDeadlines } from '../../shared/catalog-freshness'
import { createSearchIndex, inSearchScope, selectSearchJobs } from '../../shared/job-search'
import type { SearchIndex } from '../../shared/job-search'
import { createCatalogUpgrader } from '../../shared/job-upgrade'
import { createSearchRanker, groupCities } from '../../shared/matching'
import { analyzeSearchRecovery } from '../../shared/search-recovery'
import type { Catalog, Job, MatchedJob, Profile } from '../../shared/types'
import { CatalogRequestError, createCatalogReader } from './catalog-request'
import { createGlobeCities } from './globe-cities'
import type { CatalogProjectionPatch, CatalogWorkerCommand, CatalogWorkerResult, MatchFacts } from './catalog-worker-types'

interface Snapshot {
  catalog: Catalog
  deadlines: number[]
  boundary?: number
  aged?: ReturnType<typeof ageCatalog>
}

/** All mutable state belongs to this worker session, not to the public API or saved records. */
export class CatalogWorkerModel {
  private reader = createCatalogReader()
  private upgrade = createCatalogUpgrader()
  private stream = 0
  private revision = 0
  private acknowledged = 0
  private projected = 0
  private snapshots = new Map<number, Snapshot>()
  private indexedCatalog?: Catalog
  private profileKey = ''
  private index?: SearchIndex
  private rank?: ReturnType<typeof createSearchRanker>
  private sentJobs = new Map<string, Job>()
  private sentMatches = new Map<string, MatchedJob>()

  private snapshot(revision: number, now: number) {
    const snapshot = this.snapshots.get(revision)
    if (!snapshot) throw new CatalogRequestError('더 최신 공고를 준비하고 있어요.', 'CATALOG_SUPERSEDED')
    const boundary = snapshot.deadlines.reduce((latest, time) => time <= now ? Math.max(latest, time) : latest, 0)
    if (!snapshot.aged || snapshot.boundary !== boundary) {
      snapshot.aged = ageCatalog(snapshot.catalog, boundary)
      snapshot.boundary = boundary
    }
    return { ...snapshot.aged, deadlines: snapshot.deadlines }
  }

  private search(catalog: Catalog, profile: Profile) {
    const key = JSON.stringify(profile)
    if (!this.index || this.indexedCatalog !== catalog || key !== this.profileKey) {
      this.index = createSearchIndex(catalog, profile)
      this.rank = createSearchRanker(this.index, profile)
      this.indexedCatalog = catalog
      this.profileKey = key
    }
    return { index: this.index, rank: this.rank! }
  }

  private prune() {
    // Preserve the actually displayed snapshot across aborted loads and late replies.
    for (const revision of this.snapshots.keys()) {
      if (revision !== this.revision && revision !== this.acknowledged && revision !== this.projected) {
        this.snapshots.delete(revision)
      }
    }
  }

  async handle(command: CatalogWorkerCommand): Promise<CatalogWorkerResult> {
    if (command.kind === 'decode') {
      if (command.stream < this.stream || !command.initial && command.stream !== this.stream) {
        throw new CatalogRequestError('이전 공고 조회를 취소했어요.', 'CATALOG_SUPERSEDED')
      }
      if (command.initial) {
        this.stream = command.stream
        this.reader = createCatalogReader()
      }
      // Response.json, schema validation, migration and filtering all execute off the UI thread.
      const result = await this.reader(new Response(command.body, { status: command.status }), command.initial)
      const catalog = this.upgrade(result.value)
      const revision = ++this.revision
      const deadlines = catalogDeadlines(catalog)
      this.snapshots.set(revision, { catalog, deadlines })
      this.prune()
      return { kind: 'decoded', value: { revision, deadlines }, progress: result.progress }
    }
    if (command.kind === 'acknowledge') {
      if (this.snapshots.has(command.revision)) this.acknowledged = command.revision
      this.prune()
      return { kind: 'acknowledged' }
    }
    if (command.kind === 'preview') {
      const { catalog } = this.snapshot(command.revision, command.now)
      const { index } = this.search(catalog, command.profile)
      return { kind: 'previewed', count: selectSearchJobs(index, command.filters).length }
    }
    const { input, revision } = command
    const { catalog, expired, deadlines } = this.snapshot(revision, input.now)
    const { index, rank } = this.search(catalog, input.profile)
    const matches = rank(input.filters)
    const cities = groupCities(catalog, matches, input.filters)
    const remote = matches.filter(match => match.job.workMode === 'remote')
    const unmappedIds = new Set(index.entries.filter(entry =>
      inSearchScope(entry, { kind: 'unmapped' }, input.filters.region)).map(entry => entry.job.id))
    const unmapped = matches.filter(match => unmappedIds.has(match.job.id))
    const scope = input.scope
    const hasScopeResults = scope.kind === 'cities' ? cities.length > 0
      : scope.kind === 'city' ? cities.some(result => result.city.id === scope.cityId)
      : scope.kind === 'remote' ? remote.length > 0 : unmapped.length > 0
    const recovery = input.recover && Boolean(catalog.fetchedAt) && !input.collecting && !hasScopeResults
      && !catalog.boards.some(board => board.status === 'pending')
      ? analyzeSearchRecovery(index, input.filters, input.scope) : null

    const currentJobs = new Map(catalog.jobs.map(job => [job.id, job]))
    const jobs = catalog.jobs.filter(job => this.sentJobs.get(job.id) !== job)
    const removed = [...this.sentJobs.keys()].filter(id => !currentJobs.has(id))
    const facts: MatchFacts[] = []
    for (const match of matches) {
      if (this.sentMatches.get(match.job.id) === match) continue
      const { job, company: _company, ...details } = match
      facts.push({ id: job.id, ...details })
      this.sentMatches.set(job.id, match)
    }
    for (const id of removed) this.sentMatches.delete(id)
    this.sentJobs = currentJobs
    const { jobs: _jobs, ...metadata } = catalog
    const value: CatalogProjectionPatch = {
      revision, catalog: metadata, jobIds: catalog.jobs.map(job => job.id), jobs, removed, facts,
      matchIds: matches.map(match => match.job.id),
      cities: cities.map(result => ({
        id: result.city.id, matchIds: result.matches.map(match => match.job.id),
        companyCount: result.companyCount, averageScore: result.averageScore,
      })),
      remoteIds: remote.map(match => match.job.id), unmappedIds: unmapped.map(match => match.job.id),
      companyCount: new Set(matches.map(match => match.company.id)).size,
      recovery, globeCities: createGlobeCities(cities), expired, deadlines,
    }
    this.projected = revision
    this.prune()
    return { kind: 'projected', value }
  }
}
