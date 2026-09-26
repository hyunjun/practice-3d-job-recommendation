import { CITY_BY_ID, LOCATION_ALIASES } from './cities'
import { locateCities } from './city-location'
import { upgradeJobRemoteScope } from './job-remote'
import { workplaceCountrySearchText } from './job-workplace'
import type { Catalog, FactEvidence, Job } from './types'

const ROLE_LOCATION = /\b(?:this|the)\s+(?:internship|role|position|job)\s+(?:is|will be)\s+(?:based|located)\s+(?:in|at)\s+/gi
const CONDITIONAL_CONTEXT = /\b(?:if|once|after|following|upon|completion|successful|subsequent|eventually|future|then|later|may|might|could|previously|not|never)\b/i
const LOCATION_END = /[.!?;\n]|\s+(?:for|with|where|which|but|however|because|to|after|following|once|upon|and\s+(?:we|you|will|serves|candidates|offers|may)|or\s+(?:we|you))\b/i

/** Accept a whole city list, not a known city embedded in an unknown place or a sentence. */
function explicitCityList(label: string): string[] {
  const cities = locateCities(label)
  if (!cities.length) return []
  let remainder = label
  const aliases = cities.flatMap(id => LOCATION_ALIASES[id]).sort((a, b) => b.length - a.length)
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    remainder = remainder.replace(new RegExp(`(?<![\\p{L}])${escaped}(?![\\p{L}])`, 'giu'), '')
  }
  remainder = remainder.replace(/\b(?:our|the|office|offices|campus|hq|or|and)\b/gi, '').replace(/[\s,/&()–—-]/g, '')
  return remainder ? [] : cities
}

function sameCities(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every(id => right.includes(id))
}

function paragraphEvidence(paragraph: string, position: number): FactEvidence {
  // Retain the surrounding period/eligibility conditions, even beyond the stored body limit.
  if (paragraph.length <= 3000) return { source: 'description', text: paragraph }
  const start = Math.max(0, position - 500)
  const text = paragraph.slice(start, start + 2998)
  return { source: 'description', text: `${start ? '…' : ''}${text}${start + text.length < paragraph.length ? '…' : ''}` }
}

/**
 * Reconcile only explicit current-role statements with a disjoint listed city.
 * Applicant residence, company offices and future/conditional work are not workplaces.
 * Remote jobs reconcile their posting fields with explicit current-role country statements.
 * Overlapping multi-location city listings remain authoritative.
 */
export function upgradeJobLocation<T extends Job>(job: T, fullDescription?: string): T {
  if (job.workMode === 'remote') return upgradeJobRemoteScope(job, fullDescription)
  if (job.source === 'sample' || !job.cityIds.length || job.locationResolution) return job
  const description = fullDescription ?? job.description
  const roleLocation = new RegExp(ROLE_LOCATION)
  if (!roleLocation.test(description)) return job
  roleLocation.lastIndex = 0
  const statements: { label: string; cities: string[]; evidence: FactEvidence }[] = []
  for (const paragraph of description.split(/\n+/)) {
    for (const match of paragraph.matchAll(roleLocation)) {
      const before = paragraph.slice(0, match.index).split(/[.!?;]/).at(-1) ?? ''
      if (CONDITIONAL_CONTEXT.test(before)) continue
      const tail = paragraph.slice(match.index + match[0].length)
      const end = tail.search(LOCATION_END)
      const label = (end < 0 ? tail : tail.slice(0, end)).replace(/[\s,]+$/g, '').trim()
      if (end >= 0 && /^\s+(?:after|following|once|upon)\b/i.test(tail.slice(end))) continue
      const cities = explicitCityList(label)
      if (!cities.length) continue
      const evidence = paragraphEvidence(paragraph, match.index)
      if (!statements.some(statement => statement.label === label && statement.evidence.text === evidence.text)) {
        statements.push({ label, cities, evidence })
      }
    }
  }
  // A shared body may describe another valid branch of a multi-location listing.
  if (!statements.length || statements.length > 8 || statements.every(statement => statement.cities.some(id => job.cityIds.includes(id)))) return job
  const statedCityIds = [...new Set(statements.flatMap(statement => statement.cities))]
  const statedLabel = [...new Set(statements.map(statement => statement.label))].join(' / ').slice(0, 1800)
  const titleLocation = job.title.match(/\b(?:relocat(?:e|ion|ing)\s+to|internship\s+in)\s+([^()\n]+)/i)
  const corroborated = titleLocation && !CONDITIONAL_CONTEXT.test(job.title.slice(0, titleLocation.index))
    && sameCities(explicitCityList(titleLocation[1].trim()), statedCityIds)
    && statements.every(statement => sameCities(statement.cities, statedCityIds))
    && statedCityIds.every(id => !job.cityIds.includes(id))
  const status = corroborated ? 'relocation' : 'conflict'
  return {
    ...job,
    cityIds: status === 'relocation' ? statedCityIds : [],
    locationLabel: status === 'relocation' ? `${statedLabel}${job.workMode === 'hybrid' ? ' · Hybrid' : ''}` : job.locationLabel,
    locationResolution: {
      version: 1, status, listedCityIds: [...job.cityIds], listedLabel: job.locationLabel, statedCityIds, statedLabel,
      evidence: [
        ...(corroborated ? [{ source: 'title' as const, text: job.title }] : []),
        ...statements.map(statement => statement.evidence),
      ],
    },
  }
}

export function jobLocationSearchText(job: Job): string {
  const conflict = job.locationResolution?.status === 'conflict' ? job.locationResolution : undefined
  return [job.locationLabel, workplaceCountrySearchText(job), ...(conflict ? [
    conflict.statedLabel,
    ...[...conflict.listedCityIds, ...conflict.statedCityIds].flatMap(id => {
      const city = CITY_BY_ID.get(id)
      return city ? [city.name, city.en] : []
    }),
  ] : [])].join(' ')
}

/** A missing map location does not establish remote work or a different work site. */
export function isUnmappedJob(job: Pick<Job, 'workMode' | 'cityIds'>): boolean {
  return job.workMode !== 'remote' && job.cityIds.length === 0
}

export function unmappedCoverage(catalog: Pick<Catalog, 'jobs' | 'unmappedCount'>) {
  const available = catalog.jobs.filter(isUnmappedJob).length
  return {
    available,
    // Older snapshots counted these jobs but did not retain their contents.
    unavailable: catalog.unmappedCount === null ? null : Math.max(0, catalog.unmappedCount - available),
  }
}
