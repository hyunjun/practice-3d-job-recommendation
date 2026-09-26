/** A comparison key only: keep original text for display, storage, and export. */
export function normalizeSearchText(text: string): string {
  return text.normalize('NFKC').toLowerCase().normalize('NFD')
    // Fold Latin accents without removing meaningful marks from other scripts,
    // such as Japanese voicing or Indic vowels. Recompose Hangul and other text.
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1').normalize('NFC')
}

export function searchWords(query: string): string[] {
  return normalizeSearchText(query).trim().split(/\s+/).filter(Boolean)
}
