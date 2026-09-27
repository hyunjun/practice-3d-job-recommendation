import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

export async function openSavedFiles(page: Page) {
  await page.getByRole('button', { name: '기록 백업·복원', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '기록 백업과 복원', exact: true })).toBeVisible()
}
export async function downloadText(page: Page, trigger: Locator): Promise<string> {
  const pending = page.waitForEvent('download')
  await trigger.click()
  const stream = await (await pending).createReadStream()
  if (!stream) throw new Error('Synthetic browser download was not readable')
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}
export async function expectExcludedImport(page: Page, count: number) {
  const summary = page.locator('.saved-import-summary')
  const exclusion = summary.locator('p').filter({ hasText: /가상(?:의)? 공고/ })
  await expect(exclusion).toContainText(new RegExp(String.raw`(?:^|\D)${count}\s*개(?:\D|$)`))
  await expect(exclusion).toContainText(/제외|가져오지 않/)
  // Wording/markup can be aligned with main, but both meanings are required.
  const noteExplanation = summary.locator('p').filter({ hasText: '메모' })
  await expect(noteExplanation).toContainText('원본 파일')
}
export async function guardRetiredCards(page: Page) {
  await page.addInitScript(() => {
    Reflect.set(window, '__stage65RetiredPaints', [] as string[])
    new MutationObserver(() => {
      const output = Reflect.get(window, '__stage65RetiredPaints') as string[]
      if (output.length >= 4) return
      for (const title of document.querySelectorAll<HTMLElement>('.saved-title')) {
        const knownFiction = [
          'Legacy fictional opportunity 65', 'Second retired fictional opportunity 65',
          'Fictional legacy duplicate of a public ID',
        ].includes(title.textContent ?? '')
        if (title.dataset.savedJobId?.startsWith('sample-') || knownFiction)
          output.push(title.textContent ?? 'retired active card')
      }
    }).observe(document, { subtree: true, childList: true })
  })
}
export async function expectNoRetiredPaint(page: Page) {
  expect(await page.evaluate(() => Reflect.get(window, '__stage65RetiredPaints'))).toEqual([])
}
