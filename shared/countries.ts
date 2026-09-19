import { COUNTRY_DATA } from './country-data'
import type { Region } from './types'

export interface Country {
  code: string
  alpha3: string
  name: string
  englishName: string
  referenceName: string
  region: Exclude<Region, 'all'> | null
}

const koreanNames = new Intl.DisplayNames(['ko'], { type: 'region', fallback: 'none' })
const englishNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' })

export const COUNTRY_BY_CODE = new Map<string, Country>(COUNTRY_DATA.map(([code, alpha3, region, referenceName]) => [code, {
  code, alpha3, region, referenceName,
  name: koreanNames.of(code) ?? referenceName,
  englishName: englishNames.of(code) ?? referenceName,
}]))

// Keep the default country easy to find; other choices use their displayed names.
export const COUNTRY_OPTIONS: readonly (readonly [string, string])[] = [...COUNTRY_BY_CODE.values()]
  .sort((left, right) => Number(right.code === 'KR') - Number(left.code === 'KR') || left.name.localeCompare(right.name, 'ko'))
  .map(country => [country.code, country.name] as const)

export function countryName(code: string): string {
  return COUNTRY_BY_CODE.get(code)?.name ?? code
}

const ALIASES: Record<string, string[]> = {
  GB: ['UK', 'Great Britain'], US: ['U.S.', 'U.S.A.'], KR: ['Korea'],
  BA: ['Bosnia', 'Bosnia and Herzegovina'], CZ: ['Czech Republic'],
  CI: ['Ivory Coast'], TR: ['Turkey', 'Türkiye'], MM: ['Myanmar', 'Burma'],
  HK: ['Hong Kong'], MO: ['Macao', 'Macau'], TW: ['Taiwan, Province of China'],
  CD: ['Democratic Republic of Congo', 'DR Congo', 'DRC'],
  CG: ['Republic of Congo', 'Republic of the Congo'], AE: ['UAE'],
  XK: ['Kosovo', 'XKX'],
}

function normalized(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[.'’]/g, '').replace(/[,()]/g, ' ').replace(/&/g, ' and ').replace(/\s+/g, ' ').trim()
}

const codesByName = new Map<string, string>()
const namesByCode = new Map<string, string[]>()
for (const country of COUNTRY_BY_CODE.values()) {
  const names = [...new Set([country.name, country.englishName, country.referenceName, ...(ALIASES[country.code] ?? [])].map(normalized))]
  namesByCode.set(country.code, names)
  for (const value of [country.code, country.alpha3, ...names]) codesByName.set(normalized(value), country.code)
}

/** A whole country field may use an ISO code or a full country/area name. */
export function countryCode(value?: string | null): string | undefined {
  return value ? codesByName.get(normalized(value)) : undefined
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const boundary = (value: string) => `(?<![\\p{L}\\p{N}])(?:${value})(?![\\p{L}\\p{N}])`
// These names alone cannot distinguish a country from another country or a US state.
const AMBIGUOUS_NAMES = new Set(['korea', 'congo', 'georgia'])
const locationNames = [...new Set([...namesByCode.values()].flat())]
  .filter(name => !/^[a-z]{2,3}$/.test(name) && !AMBIGUOUS_NAMES.has(name))
  .sort((left, right) => right.length - left.length || left.localeCompare(right, 'en'))
const locationNamePattern = new RegExp(boundary(locationNames.map(escape).join('|')), 'gu')
const namePatterns = new Map([...namesByCode].map(([code, names]) => [
  code, new RegExp(boundary(names.map(escape).join('|')), 'u'),
]))
// Bare state abbreviations do not establish a country. Structured country fields
// can still use every supported alpha-2 / alpha-3 code.
const AMBIGUOUS_CODES = new Set(['AND', 'ARE'])

/**
 * Read explicit location names, with longest names winning over contained names.
 * Retained country-only metadata survives legacy migration unless a complete
 * place name proves an old substring inference wrong (e.g. North Korea ≠ KR).
 */
export function locationCountries(location: string, retained: string[] = []): string[] {
  const text = normalized(location)
  const matches = [...text.matchAll(locationNamePattern)]
    .filter(match => match[0] !== 'jersey' || !/\bnew $/.test(text.slice(0, match.index)) && !/^ city\b/.test(text.slice(match.index + match[0].length)))
    .map(match => ({ code: codesByName.get(match[0])!, text: match[0] }))
  const unnamed = text.replace(locationNamePattern, ' ')
  for (const match of location.matchAll(/(?<![A-Za-z])(?:US|USA|U\.S\.(?:A\.)?|UK|U\.K\.|GBR)(?![A-Za-z])/g)) {
    const name = normalized(match[0])
    if (new RegExp(boundary(escape(name)), 'u').test(unnamed)) matches.push({ code: countryCode(match[0])!, text: name })
  }
  for (const part of location.split(/[;,|·•/()]/)) {
    const codeText = part.trim().replace(/^remote(?:\s*[-:–—]\s*|\s+|$)/i, '')
      .replace(/(?:\s*[-–—]\s*|\s+)remote$/i, '').trim()
    const common = /^(?:US|USA|GB|GBR|UK|U\.S\.(?:A\.)?|U\.K\.)$/i.test(codeText)
    if (!common && (!/^[A-Z]{3}$/.test(codeText) || AMBIGUOUS_CODES.has(codeText))) continue
    const code = countryCode(codeText)
    if (code) matches.push({ code, text: normalized(codeText) })
  }
  const countries = new Set(matches.map(match => match.code))
  for (const previous of retained) {
    const code = countryCode(previous) ?? previous
    const shadowed = matches.some(match => match.code !== code && namePatterns.get(code)?.test(match.text))
    if (countries.has(code) || !shadowed) countries.add(code)
  }
  return [...countries]
}

export function countrySearchText(codes: string[]): string[] {
  return codes.flatMap(code => {
    const country = COUNTRY_BY_CODE.get(code)
    return country ? [code, country.alpha3, country.name, country.englishName, country.referenceName] : [code]
  })
}
