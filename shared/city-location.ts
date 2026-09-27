import { CITY_BY_ID, LOCATION_ALIASES } from './cities'
import { countryCode, locationCountries } from './countries'

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Compile once: both collectors and the catalog worker resolve many locations.
const matchers = Object.entries(LOCATION_ALIASES).map(([id, aliases]) => ({
  id,
  pattern: new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...aliases].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'giu'),
}))
// A conjunction before another city starts a separate workplace. Requiring a
// city also preserves country names such as Trinidad and Tobago and a terminal
// Oregon abbreviation in "Portland OR". Letter case does not change the list.
const placeBoundary = new RegExp(
  `[;|·•/\\n]|\\s+(?:and|or|&)\\s+(?=${matchers.map(({ pattern }) => pattern.source).join('|')})`, 'giu',
)

const US_STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
}
const stateNames = Object.keys(US_STATES).sort((a, b) => b.length - a.length).map(escape).join('|')
const stateSuffix = new RegExp(`^\\s*(?:,\\s*|[-–—]\\s*|\\s+)(?:(${stateNames})|([A-Z]{2}))(?=$|[,\\s()])`, 'i')
const stateCodes = new Set(Object.values(US_STATES))
const coveredStates: Record<string, string> = { atlanta: 'GA', 'los-angeles': 'CA', portland: 'OR' }
const excludedSuffixes: Record<string, RegExp> = {
  london: /^[,\s-]+(?:ontario|on\b|canada)\b/i,
  dublin: /^[,\s-]+(?:ohio|oh\b|california|ca\b)\b/i,
  vancouver: /^[,\s-]+(?:washington|wa\b)\b/i,
  portland: /^[,\s-]+(?:victoria|vic|new south wales|nsw|queensland|qld|australia|ontario|on|british columbia|bc|jamaica|england|dorset)\b/i,
  wellington: /^[,\s-]+(?:somerset|shropshire|england|ontario|on|canada|new south wales|nsw|australia)\b/i,
  christchurch: /^[,\s-]+(?:dorset|hampshire|cambridgeshire|england)\b/i,
  auckland: /^[,\s-]+(?:durham|england)\b/i,
}

function belongsToCity(id: string, segment: string, index: number, length: number): boolean {
  const before = segment.slice(0, index)
  const after = segment.slice(index + length)
  if (excludedSuffixes[id]?.test(after)) return false
  if (id === 'auckland' && /\bbishop\s+$/i.test(before)) return false
  const suffix = after.match(stateSuffix)
  // US-OR-Portland and US-GA-Atlanta are common structured display labels.
  const prefix = before.match(/\b(?:US|USA)[-_,\s]+([A-Z]{2})[-_,\s]+$/i)
  const cityCountry = CITY_BY_ID.get(id)?.countryCode
  const abbreviation = suffix?.[2]
  const stateCode = abbreviation && (abbreviation === abbreviation.toUpperCase()
    || /^\s*[,–—-]/.test(after) || after.trim().toLowerCase() === abbreviation.toLowerCase())
    ? abbreviation.toUpperCase() : undefined
  // Berlin, DE / Bengaluru, IN / Vancouver, CA may use country abbreviations.
  // An explicit US prefix or a full state name still establishes a US state.
  if (!prefix && stateCode === cityCountry) return true
  // Lowercase "or" / "in" in a city list are conjunctions, not Oregon / Indiana.
  const state = prefix?.[1].toUpperCase() ?? (suffix?.[1] ? US_STATES[suffix[1].toLowerCase()] : stateCode)
  if (state && stateCodes.has(state)) {
    if (cityCountry !== 'US') return false
    if (coveredStates[id] && coveredStates[id] !== state) return false
  }
  return true
}

/** Resolve each listed place independently so a namesake cannot hide a valid second location. */
export function locateCities(location: string): string[] {
  const found = new Set<string>()
  for (const segment of location.normalize('NFKC').split(placeBoundary)) {
    const countries = locationCountries(segment)
    for (const { id, pattern } of matchers) {
      const city = CITY_BY_ID.get(id)!
      if (countries.length && !countries.includes(city.countryCode)) continue
      for (const match of segment.matchAll(pattern)) {
        if (belongsToCity(id, segment, match.index, match[0].length)) {
          found.add(id)
          break
        }
      }
    }
  }
  return matchers.filter(({ id }) => found.has(id)).map(({ id }) => id)
}

/** An explicit structured country always bounds the inferred map locations. */
export function locateCitiesInCountry(location: string, country?: string): string[] {
  const code = countryCode(country)
  if (country?.trim() && !code) return []
  return locateCities(location).filter(id => !code || CITY_BY_ID.get(id)?.countryCode === code)
}
