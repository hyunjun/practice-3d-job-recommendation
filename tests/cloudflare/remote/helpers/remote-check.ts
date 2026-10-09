import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FullConfig } from '@playwright/test'
import { ApiBudgetLedger, LedgerError, REMOTE_MAX_API_REQUESTS, REMOTE_ORIGIN, remoteConfigFromEnv } from '../ledger'

/** The whole smoke needs at most this many public API attempts; refuse to start without that much budget left. */
export const SMOKE_BUDGET_REQUIRED = 12
const worktree = fileURLToPath(new URL('../../../..', import.meta.url))

/**
 * Global setup: validate the runner-supplied scope and the persistent ledger
 * without sending any request. A missing ledger fails closed: it must have been
 * initialised by the approved owner step (tests/cloudflare/remote/ledger-init.ts).
 */
export default async function requireDeployedReadOnlyScope(config: FullConfig) {
  const remote = remoteConfigFromEnv()
  assert.equal(remote.origin, REMOTE_ORIGIN)
  assert.equal(remote.max, REMOTE_MAX_API_REQUESTS)
  const origins = new Set(config.projects.map(project => new URL(project.use.baseURL!).origin))
  assert.deepEqual([...origins], [REMOTE_ORIGIN], 'Every remote project must target exactly the authorized production origin.')
  for (const project of config.projects) assert.equal(project.use.serviceWorkers, 'block', 'Service workers must be blocked in the remote browser context.')
  const ledger = new ApiBudgetLedger(remote, 'global-setup')
  let file
  try {
    file = await ledger.read()
  } catch (error) {
    if (error instanceof LedgerError && error.code === 'LEDGER_MISSING') {
      assert.fail(`The persistent ledger ${remote.ledgerPath} is missing; run the approved owner step (remote-ledger-init) first. No request was sent.`)
    }
    throw error
  }
  const remaining = file.max - file.attempts.length
  assert.ok(remaining >= SMOKE_BUDGET_REQUIRED, `Only ${remaining} public API attempts remain in the persistent ledger; the smoke needs ${SMOKE_BUDGET_REQUIRED}.`)
  await mkdir(path.join(worktree, '.local/remote-smoke'), { recursive: true })
  await writeFile(path.join(worktree, '.local/remote-smoke/setup.json'), `${JSON.stringify({
    at: new Date().toISOString(), origin: remote.origin, max: remote.max, ledgerPath: remote.ledgerPath, initialized: file.initialized ?? null,
    attemptsBefore: file.attempts.length, remainingBefore: remaining, requestsSentBySetup: 0,
  }, null, 2)}\n`)
}
