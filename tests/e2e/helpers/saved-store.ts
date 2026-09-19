import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { SavedJob } from '../../../shared/types'

export async function waitForSavedCommit(page: Page) {
  await expect(page.locator('.main-nav button').filter({ hasText: '저장한 기회' })).toHaveAttribute('aria-busy', 'false')
}

/** Read committed records; legacy fixture writes deliberately exercise migration. */
export async function readSaved(page: Page): Promise<SavedJob[]> {
  await waitForSavedCommit(page)
  return page.evaluate(() => new Promise<SavedJob[]>((resolve, reject) => {
    const opening = indexedDB.open('orbit-saved-opportunities')
    opening.onerror = () => reject(opening.error)
    opening.onupgradeneeded = () => { opening.transaction?.abort(); reject(new Error('Saved database has not been initialized')) }
    opening.onsuccess = () => {
      const db = opening.result
      const tx = db.transaction('records', 'readonly')
      const request = tx.objectStore('records').getAll()
      tx.oncomplete = () => {
        db.close()
        resolve(request.result.sort((a, b) => b.order - a.order || a.id.localeCompare(b.id)).map(entry => entry.record))
      }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }))
}

export async function readSavedJson(page: Page): Promise<string> {
  return JSON.stringify(await readSaved(page))
}
