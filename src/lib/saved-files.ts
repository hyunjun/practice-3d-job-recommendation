import type { SavedRecovery } from './saved-store'

export function downloadSavedFile(contents: string, name: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json;charset=utf-8' }))
  const anchor = document.createElement('a')
  try {
    anchor.href = url
    anchor.download = name
    document.body.append(anchor)
    anchor.click()
  } finally {
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

export function downloadSavedRecovery(sources: SavedRecovery[]) {
  downloadSavedFile(JSON.stringify({
    format: 'orbit-saved-recovery', version: 1, exportedAt: new Date().toISOString(), sources,
  }, null, 2), `orbit-saved-recovery-${new Date().toISOString().slice(0, 10)}.json`)
}
