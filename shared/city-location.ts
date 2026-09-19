import { LOCATION_ALIASES } from './cities'

export function locateCities(location: string): string[] {
  const text = location.toLowerCase()
  const ambiguousLocations: Record<string, RegExp> = {
    london: /\blondon,?\s+(?:ontario|on\b|canada)/i,
    paris: /\bparis,?\s+(?:texas|tx\b)/i,
    dublin: /\bdublin,?\s+(?:ohio|oh\b|california|ca\b)/i,
    vancouver: /\bvancouver,?\s+(?:washington|wa\b)/i,
  }
  return Object.entries(LOCATION_ALIASES).filter(([id, aliases]) => !ambiguousLocations[id]?.test(text) && aliases.some(alias => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^\\p{L}])${escaped}($|[^\\p{L}])`, 'iu').test(text)
  })).map(([id]) => id)
}
