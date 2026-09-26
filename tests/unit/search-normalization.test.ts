import { describe, expect, it } from 'vitest'
import { createSearchIndex, selectSearchJobs } from '../../shared/job-search'
import { createSearchRanker } from '../../shared/matching'
import { createJobRevision } from '../../shared/posting-status'
import { normalizeSearchText, searchWords } from '../../shared/search-text'
import type { Filters } from '../../shared/types'
import {
  NORMALIZATION_FILTERS, NORMALIZATION_PROFILE, markedScriptCatalog,
  normalizationCatalog, normalizationJob, normalizationSaved,
} from '../fixtures/search-normalization'

describe('literal Unicode search comparison keys', () => {
  it.each([
    ['Montréal', 'montreal'],
    ['Montre\u0301al', 'montreal'],
    ['São Paulo', 'sao paulo'],
    ['Sa\u0303o Paulo', 'sao paulo'],
    ['Reykjavík', 'reykjavik'],
    ['Ångström déjà vu', 'angstrom deja vu'],
    ['ắ ễ ṩ', 'a e s'],
    ['e\u1ab0', 'e'],
    ['Ｏｆｆｉｃｅ　Ｓｅｏｕｌ', 'office seoul'],
    ['oﬃce', 'office'],
    ['Ｃ＋＋ Ｃ＃ ．ＮＥＴ', 'c++ c# .net'],
    ['서울', '서울'],
    ['서울', '서울'],
    ['ガ', 'ガ'],
    ['カ\u3099', 'ガ'],
    ['ｶﾞ', 'ガ'],
    ['カ', 'カ'],
    ['कि', 'कि'],
    ['क', 'क'],
    ['عَلَم', 'عَلَم'],
    ['علم', 'علم'],
    ['שָׁלוֹם', 'שָׁלוֹם'],
    ['ά й', 'ά й'],
    ['e\u0301क\u093f', 'eकि'],
    ['\u0301e', '\u0301e'],
    ['e \u0301', 'e \u0301'],
    ['C++/C#/.NET', 'c++/c#/.net'],
    ['Straße Øresund Łódź', 'straße øresund łodz'],
  ])('normalizes %j to the explicitly authored %j', (source, expected) => {
    expect(normalizeSearchText(source)).toBe(expected)
  })

  it.each([
    ['', []],
    [' \t\n\u00a0\u3000 ', []],
    [' \tＭＯＮＴＲＥＡＬ\u00a0Ｃ＋＋\n', ['montreal', 'c++']],
    ['São\u3000Paulo\t.NET', ['sao', 'paulo', '.net']],
    ['Ｃ＃  ガ  कि  عَلَم', ['c#', 'ガ', 'कि', 'عَلَم']],
    ['Cafe\u0301 Café', ['cafe', 'cafe']],
    ['C++/C#', ['c++/c#']],
  ])('tokenizes %j without dropping literal punctuation or marked scripts', (query, expected) => {
    expect(searchWords(query)).toEqual(expected)
  })
})

describe('literal catalog result sets after Unicode comparison', () => {
  const catalog = normalizationCatalog()
  const index = createSearchIndex(catalog, NORMALIZATION_PROFILE)

  it.each([
    ['Montreal', ['greenhouse-cedar56-01', 'greenhouse-cedar56-02', 'greenhouse-lumen56-03']],
    ['Montréal', ['greenhouse-cedar56-01', 'greenhouse-cedar56-02', 'greenhouse-lumen56-03']],
    ['Montre\u0301al', ['greenhouse-cedar56-01', 'greenhouse-cedar56-02', 'greenhouse-lumen56-03']],
    ['Ｍｏｎｔｒｅａｌ', ['greenhouse-cedar56-01', 'greenhouse-cedar56-02', 'greenhouse-lumen56-03']],
    ['Sao Paulo', ['greenhouse-cedar56-04', 'greenhouse-lumen56-05']],
    ['São Paulo', ['greenhouse-cedar56-04', 'greenhouse-lumen56-05']],
    ['Sa\u0303o\u00a0Paulo', ['greenhouse-cedar56-04', 'greenhouse-lumen56-05']],
    ['Reykjavik', ['greenhouse-lumen56-11']],
    ['서울', ['greenhouse-cedar56-06', 'greenhouse-lumen56-07']],
    ['서울', ['greenhouse-cedar56-06', 'greenhouse-lumen56-07']],
    ['Ｓｅｏｕｌ', ['greenhouse-cedar56-06', 'greenhouse-lumen56-07']],
    ['office', ['greenhouse-lumen56-08']],
    ['oﬃce', ['greenhouse-lumen56-08']],
    ['  ＭＯＮＴＲＥＡＬ\tＣ＋＋  ', ['greenhouse-cedar56-01']],
    ['Montreal C#', ['greenhouse-cedar56-02']],
    ['Montréal .NET', ['greenhouse-lumen56-03']],
    ['Montréal C++ C#', []],
    ['Montréal C+', ['greenhouse-cedar56-01']],
    ['Montréal NET.', []],
    ['Montréal #.', []],
    ['São Harbor', ['greenhouse-lumen56-05']],
    ['cafe relay', ['greenhouse-cedar56-09', 'greenhouse-lumen56-10']],
    ['café atlas remote', ['greenhouse-cedar56-09']],
    ['Atlantis Montreal', []],
    ['PRIVATE56', []],
  ])('returns exactly the fictional IDs for %j', (query, expected) => {
    expect(selectSearchJobs(index, { ...NORMALIZATION_FILTERS, query }).map(entry => entry.job.id)).toEqual(expected)
  })

  it.each([
    ['ガ', ['greenhouse-lumen56-kana-voiced']],
    ['カ\u3099', ['greenhouse-lumen56-kana-voiced']],
    ['ｶﾞ', ['greenhouse-lumen56-kana-voiced']],
    ['カ', ['greenhouse-lumen56-kana-plain']],
    ['कि', ['greenhouse-lumen56-indic-marked']],
    ['عَلَم', ['greenhouse-lumen56-arabic-marked']],
    ['علم', ['greenhouse-lumen56-arabic-plain']],
  ])('does not erase meaningful marks when searching %j', (query, expected) => {
    const markedIndex = createSearchIndex(markedScriptCatalog(), NORMALIZATION_PROFILE)
    expect(selectSearchJobs(markedIndex, { ...NORMALIZATION_FILTERS, query }).map(entry => entry.job.id)).toEqual(expected)
  })

  it.each([
    ['Straße', 'strasse', false],
    ['Øresund', 'oresund', false],
    ['Montréal', 'montreel', false],
    ['Καφές', 'kafes', false],
    ['क', 'कि', false],
    ['علم', 'عَلَم', false],
    ['e क', 'e कि', false],
    ['Ｃ＋＋', 'C#', false],
    ['C#', 'C++', false],
    ['NET', '.NET', false],
    ['e\u0301 ガ', 'e カ', false],
    ['Cafe\u0301', 'Café', true],
    ['Café', 'Cafe\u0301', true],
    ['서울', '서울', true],
    ['서울', '서울', true],
    ['カ\u3099', 'ガ', true],
  ])('searching source %j with %j yields %j without transliteration inference', (text, query, expected) => {
    const single = normalizationCatalog([
      normalizationJob('greenhouse-lumen56-boundary', { title: `Backend Engineer — ${text}` }),
    ], 1)
    const selected = selectSearchJobs(createSearchIndex(single, NORMALIZATION_PROFILE), { ...NORMALIZATION_FILTERS, query })
    expect(selected.map(entry => entry.job.id)).toEqual(expected ? ['greenhouse-lumen56-boundary'] : [])
  })

  it('retains the same job ordering across accent narrowing, hard filters, empty results and widening', () => {
    const rank = createSearchRanker(index, NORMALIZATION_PROFILE)
    const cases: [Partial<Filters>, string[]][] = [
      [{ query: 'Montreal' }, ['greenhouse-cedar56-01', 'greenhouse-cedar56-02', 'greenhouse-lumen56-03']],
      [{ query: 'Montréal', employment: 'contract' }, ['greenhouse-cedar56-02']],
      [{ query: 'Montre\u0301al', includeUnknownSalary: false }, ['greenhouse-cedar56-01', 'greenhouse-cedar56-02']],
      [{ query: 'Montreal', region: 'europe' }, []],
      [{ query: 'Montréal', region: 'americas' }, ['greenhouse-cedar56-01', 'greenhouse-cedar56-02', 'greenhouse-lumen56-03']],
      [{ query: 'private-no-such-opening' }, []],
      [{ query: 'Ｍｏｎｔｒｅａｌ' }, ['greenhouse-cedar56-01', 'greenhouse-cedar56-02', 'greenhouse-lumen56-03']],
    ]
    for (const [filters, ids] of cases) {
      expect(rank({ ...NORMALIZATION_FILTERS, ...filters }).map(match => match.job.id)).toEqual(ids)
    }
  })

  it('keeps residence restrictions and the mapped, remote and unmapped scopes intact', () => {
    const rank = createSearchRanker(index, NORMALIZATION_PROFILE)
    expect(rank({
      ...NORMALIZATION_FILTERS, query: 'cafe relay', workMode: 'remote', remoteEligibleOnly: true,
    }).map(match => match.job.id)).toEqual(['greenhouse-cedar56-09'])
    expect(rank({
      ...NORMALIZATION_FILTERS, query: 'café relay', workMode: 'remote', remoteEligibleOnly: false,
    }).map(match => match.job.id)).toEqual(['greenhouse-cedar56-09', 'greenhouse-lumen56-10'])
    expect(rank({
      ...NORMALIZATION_FILTERS, query: 'Montreal', workMode: 'remote',
    })).toEqual([])
    expect(selectSearchJobs(index, { ...NORMALIZATION_FILTERS, query: 'Ｓｅｏｕｌ' }).map(entry => ({
      id: entry.job.id, cities: entry.job.cityIds, mode: entry.job.workMode,
    }))).toEqual([
      { id: 'greenhouse-cedar56-06', cities: ['seoul'], mode: 'onsite' },
      { id: 'greenhouse-lumen56-07', cities: ['seoul'], mode: 'onsite' },
    ])
  })

  it('rebuilds same-ID search snapshots without leaking stale spelling or changing prior snapshots', () => {
    const oldCatalog = normalizationCatalog([
      normalizationJob('greenhouse-lumen56-updated', { title: 'Backend Engineer — Reykjavík Signal' }),
    ], 1)
    const old = createSearchIndex(oldCatalog, NORMALIZATION_PROFILE)
    const revisedCatalog = {
      ...oldCatalog,
      companies: oldCatalog.companies.map(company => ({ ...company, name: 'Cafe\u0301 Compass' })),
      jobs: oldCatalog.jobs.map(job => ({ ...job, title: 'Backend Engineer — São Paulo Signal' })),
    }
    const revised = createSearchIndex(revisedCatalog, NORMALIZATION_PROFILE)
    expect(selectSearchJobs(old, { ...NORMALIZATION_FILTERS, query: 'reykjavik' }).map(entry => entry.job.id))
      .toEqual(['greenhouse-lumen56-updated'])
    expect(selectSearchJobs(revised, { ...NORMALIZATION_FILTERS, query: 'reykjavik' })).toEqual([])
    expect(selectSearchJobs(revised, { ...NORMALIZATION_FILTERS, query: 'cafe sao' }).map(entry => entry.job.id))
      .toEqual(['greenhouse-lumen56-updated'])
    expect(selectSearchJobs(old, { ...NORMALIZATION_FILTERS, query: 'cafe sao' })).toEqual([])
  })

  it('leaves source, filters, saved notes and posting revision inputs byte-identical', async () => {
    const source = normalizationCatalog()
    const records = normalizationSaved()
    const filters = { ...NORMALIZATION_FILTERS, query: '  Ｍｏｎｔｒｅ\u0301ａｌ Ｃ＃  ' }
    const before = JSON.stringify({ source, records, filters })
    const revisions = await Promise.all(source.jobs.map(job => createJobRevision(job)))
    const prepared = createSearchIndex(source, NORMALIZATION_PROFILE)
    expect(selectSearchJobs(prepared, filters).map(entry => entry.job.id)).toEqual(['greenhouse-cedar56-02'])
    for (const record of records) normalizeSearchText(record.note)
    expect(JSON.stringify({ source, records, filters })).toBe(before)
    expect(source.jobs[1].locationLabel).toBe('Montre\u0301al, Canada')
    expect(source.companies[0].name).toBe('Café Atlas')
    expect(records[1].note).toBe('Cafe\u0301 follow-up')
    expect(await Promise.all(source.jobs.map(job => createJobRevision(job)))).toEqual(revisions)
  })
})
