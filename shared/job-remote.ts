import { CITY_BY_ID } from './cities'
import { locateCities } from './city-location'
import { countryCode, countryName, locationCountries } from './countries'
import { REMOTE_SCOPE_VERSION } from './types'
import type { FactEvidence, Job, JobRemoteScopeResolution } from './types'

type RemoteScope = Pick<Job, 'remoteCountries' | 'remoteWorldwide' | 'remoteScopeUnknown' | 'remoteRegions' | 'remoteScopeVersion'>
const RESTRICTED = /\b(?:except|excluding|outside|not worldwide|not global)\b/i
// Preserve the established display order while adding independent country codes.
const COUNTRY_ORDER = 'US CA GB DE NL FR IE SE CH ES PT SG KR JP AU IN'.split(' ')
const orderedCountries = (countries: Iterable<string>) => {
  const order = (code: string) => COUNTRY_ORDER.includes(code) ? COUNTRY_ORDER.indexOf(code) : COUNTRY_ORDER.length
  return [...new Set(countries)].sort((left, right) => order(left) - order(right) || left.localeCompare(right, 'en'))
}

export function remoteScope(location: string, retainedCountries: string[] = []): RemoteScope {
  if (RESTRICTED.test(location)) {
    return { remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: true, remoteScopeVersion: REMOTE_SCOPE_VERSION }
  }
  const remoteWorldwide = /\b(?:worldwide|anywhere in the world|global[\s,·(-]+remote|remote[\s,·(-]+global)\b/i.test(location) || /^global$/i.test(location.trim())
  const countries = new Set(locationCountries(location, retainedCountries))
  for (const id of locateCities(location)) {
    const city = CITY_BY_ID.get(id)
    if (city) countries.add(city.countryCode)
  }
  const remoteRegions: NonNullable<Job['remoteRegions']> = []
  if (/\b(?:americas?|north america|south america)\b/i.test(location) || /\bAMER\b/.test(location)) remoteRegions.push('americas')
  if (/\beurope(?:an(?: union)?)?\b/i.test(location) || /\bEU\b/.test(location)) remoteRegions.push('europe')
  if (/\b(?:asia[\s-]*(?:and |& )?pacific|APAC)\b/i.test(location)) remoteRegions.push('asia-pacific')
  return {
    remoteCountries: orderedCountries(countries),
    remoteWorldwide, remoteScopeUnknown: !remoteWorldwide && countries.size === 0,
    remoteScopeVersion: REMOTE_SCOPE_VERSION,
    ...(remoteRegions.length ? { remoteRegions } : {}),
  }
}

const ROLE = String.raw`(?:this|the)\s+(?:(?:fully\s+)?remote\s+)?(?:role|position|job)`
const ROLE_COUNTRY_PATTERNS = [
  new RegExp(String.raw`^${ROLE}\s+is\s+(not\s+)?(?:only\s+)?(?:open|available)\s+to\s+(?:candidates|applicants)\s+(?:(?:who\s+are|currently)\s+)?(?:based|located|living|residing)\s+in\s+(.+)$`, 'i'),
  new RegExp(String.raw`^${ROLE}\s+is\s+(not\s+)?(.+?)\s*[-–—]\s*remote(?:[\s-]+eligible)?[.!]?$`, 'i'),
  new RegExp(String.raw`^${ROLE}\s+(?:can\s+be|is)\s+(not\s+)?(?:performed|worked)\s+remotely\s+(?:from|in)\s+(.+)$`, 'i'),
  new RegExp(String.raw`^(?:candidates|applicants)\s+for\s+${ROLE}\s+must\s+(not\s+)?(?:be\s+(?:based|located)|reside|live)\s+in\s+(.+)$`, 'i'),
  new RegExp(String.raw`^for\s+(?:this|the)\s+(?:vacancy|role|position|job),?\s+remote\s+work\s+is\s+(not\s+)?(?:available|permitted)\s+(?:only\s+)?(?:to\s+(?:people|candidates|applicants)\s+who\s+(?:live|reside)\s+in|from|in)\s+(.+)$`, 'i'),
  new RegExp(String.raw`^location\s+for\s+${ROLE}\s*:\s*(not\s+)?(.+?)\s*[-–—]\s*remote(?:[\s-]+eligible)?[.!]?$`, 'i'),
]
const CONDITIONAL_COUNTRY = /\b(?:if|unless|except|excluding|outside|after|following|once|upon|future|previously|formerly|eventually|may|might|could|would|preferred|preferably|ideally|for example|such as)\b/i
const EXAMPLE_HEADING = /^(?:examples?|sample(?:\s+\w+){0,3}|hypothetical(?:\s+\w+){0,3}|other\s+(?:roles|jobs|positions)|future\s+(?:roles|jobs|positions|opportunities))\s*:?$/i
const MAX_EVIDENCE = 8

/** Resolve the entire list; a country embedded in prose or an unknown region is insufficient. */
function explicitCountryList(label: string): string[] | undefined {
  const value = label.trim().replace(/[.!]+$/, '').replace(/\s+only$/i, '').trim()
  if (!value || value.length > 2000 || CONDITIONAL_COUNTRY.test(value)) return undefined
  const memo = new Map<string, string[] | undefined>()
  const parse = (part: string): string[] | undefined => {
    const text = part.trim().replace(/^the\s+/i, '')
    if (memo.has(text)) return memo.get(text)
    memo.set(text, undefined)
    const code = countryCode(text)
    // Reuse the location parser's guards for state abbreviations, Georgia, Korea, etc.
    if (code && locationCountries(text).includes(code)) {
      const result = [code]
      memo.set(text, result)
      return result
    }
    for (const separator of text.matchAll(/,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+|\s*[/&]\s*/gi)) {
      const left = parse(text.slice(0, separator.index))
      if (!left) continue
      const right = parse(text.slice(separator.index + separator[0].length))
      if (!right) continue
      const result = orderedCountries([...left, ...right])
      memo.set(text, result)
      return result
    }
    return undefined
  }
  return parse(value)
}

interface CountryStatement {
  countries: string[]
  excluded: boolean
  evidence: JobRemoteScopeResolution['evidence'][number]
}

function countryStatements(description: string, retained: readonly FactEvidence[]): CountryStatement[] {
  // Repeated headings in the body still reset example/real-role context.
  const paragraphs = description.split(/\n+/).map(line => line.trim()).filter(Boolean)
  const seen = new Set(paragraphs)
  for (const item of retained) {
    if (item.source !== 'description') continue
    for (const paragraph of item.text.split(/\n+/).map(line => line.trim()).filter(Boolean)) {
      if (!seen.has(paragraph)) { seen.add(paragraph); paragraphs.push(paragraph) }
    }
  }
  const statements: CountryStatement[] = []
  let example = false
  for (const paragraph of paragraphs) {
    if (EXAMPLE_HEADING.test(paragraph)) { example = true; continue }
    if (paragraph.length < 100 && !/[.!?]/.test(paragraph) && !/\b(?:is|must|can)\b/i.test(paragraph)) {
      example = false
    }
    if (example) continue
    // Protect abbreviation periods without changing offsets into the original paragraph.
    const text = paragraph.replace(/\b(?:U\.S\.(?:A\.)?|U\.K\.)/g, abbreviation => abbreviation.replace(/\./g, '·'))
    let offset = 0
    for (const fragment of text.split(/(?<=[.!?;])\s+/)) {
      const position = text.indexOf(fragment, offset)
      offset = position + fragment.length
      const sentence = paragraph.slice(position, offset).trim()
        .replace(/\bU\.S\.(?:A\.)?/g, 'US').replace(/\bU\.K\./g, 'UK').replace(/\bisn['’]t\b/gi, 'is not')
        .replace(/^[#*•-]+\s*/, '')
        .replace(/^(?:please note(?: that)?|note|your location|location)\s*:\s*/i, '')
      if (/\?\s*$/.test(sentence)) continue
      for (const pattern of ROLE_COUNTRY_PATTERNS) {
        const match = sentence.match(pattern)
        if (!match) continue
        const countries = explicitCountryList(match[2])
        if (!countries?.length) break
        const start = paragraph.length > 3000 ? Math.max(0, position - 350) : 0
        const excerpt = paragraph.slice(start, start + 2998)
        const evidence: CountryStatement['evidence'] = {
          source: 'description',
          text: paragraph.length <= 3000 ? paragraph : `${start ? '…' : ''}${excerpt}${start + excerpt.length < paragraph.length ? '…' : ''}`,
        }
        statements.push({ countries, excluded: Boolean(match[1]), evidence })
        break
      }
    }
  }
  return statements
}

function genericRemoteLocation(location: string): boolean {
  return !location.replace(/\b(?:fully|remote|eligible|global|worldwide|anywhere(?: in the world)?|work from home)\b|100%|근무지 미확인/gi, '')
    .replace(/[\s,;:·|/()[\]–—-]/g, '')
}

/** Reconcile this posting's public facts, never the user's residence or a company's offices. */
export function upgradeJobRemoteScope<T extends Job>(job: T, fullDescription?: string): T {
  if (job.source === 'sample' || job.workMode !== 'remote'
    || job.remoteScopeVersion === REMOTE_SCOPE_VERSION && fullDescription === undefined) return job
  const { remoteScopeResolution: previous, ...original } = job
  const scope = remoteScope(job.locationLabel, previous?.listedCountries ?? job.remoteCountries)
  const worldwide = !RESTRICTED.test(job.locationLabel) && (scope.remoteWorldwide || (previous?.listedWorldwide ?? job.remoteWorldwide))
  const regions = [...new Set([...(job.remoteRegions ?? []), ...(scope.remoteRegions ?? [])])]
  const statements = countryStatements(fullDescription ?? job.description, fullDescription === undefined ? previous?.evidence ?? [] : [])
  let countries = scope.remoteCountries
  let remoteWorldwide = worldwide
  let resolution: JobRemoteScopeResolution | undefined
  if (statements.length) {
    const included = statements.filter(statement => !statement.excluded)
    const excluded = new Set(statements.filter(statement => statement.excluded).flatMap(statement => statement.countries))
    const evidence = [...new Map(statements.map(statement => [statement.evidence.text, statement.evidence])).values()]
    // A region-specific listing may share its body with another branch. Geographic
    // map groups must not be expanded into employment eligibility to reconcile it.
    const countryBasis = countries.length > 0 || worldwide || genericRemoteLocation(job.locationLabel)
    if (included.length) {
      countries = included.reduce((common, statement) => common.filter(code => statement.countries.includes(code)),
        countries.length ? countries : included[0].countries)
    }
    countries = countries.filter(code => !excluded.has(code))
    remoteWorldwide = false
    if (!countryBasis || RESTRICTED.test(job.locationLabel) || evidence.length > MAX_EVIDENCE) countries = []
    resolution = {
      version: 1, status: countries.length ? 'description' : 'unconfirmed',
      listedCountries: scope.remoteCountries, listedWorldwide: worldwide,
      evidence: evidence.slice(0, MAX_EVIDENCE),
      ...(evidence.length > MAX_EVIDENCE ? { truncated: true } : {}),
    }
  }
  return {
    ...original, ...scope, remoteCountries: orderedCountries(countries),
    remoteWorldwide, remoteScopeUnknown: !remoteWorldwide && countries.length === 0,
    ...(regions.length ? { remoteRegions: regions } : {}),
    ...(resolution ? { remoteScopeResolution: resolution } : {}),
  } as T
}

export const REMOTE_SCOPE_CAUTION = '지역에 포함되어도 취업 허가·국적·주별 제한·협업 시간대는 별도로 확인해야 해요.'

export function remoteScopeNote(job: Job): string {
  const resolution = upgradeJobRemoteScope(job).remoteScopeResolution
  if (!resolution) return ''
  return resolution.status === 'description'
    ? '이 공고의 본문에 명시된 국가를 반영했어요.'
    : '게시 위치와 본문 조건을 하나의 국가 목록으로 확정하지 못했어요. 거주 국가에 포함된 공고로 분류하지 않아요.'
}

export function remoteScopeLabel(job: Job): string {
  const current = upgradeJobRemoteScope(job)
  if (current.workMode !== 'remote') return ''
  return current.remoteWorldwide ? '전 세계 · 공고에 Global / Worldwide 명시'
    : current.remoteCountries.length ? current.remoteCountries.map(countryName).join(' · ') : '국가별 근무 지역 미확인'
}
