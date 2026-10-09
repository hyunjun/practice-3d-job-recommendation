import { ApiBudgetLedger, REMOTE_MAX_API_REQUESTS, REMOTE_ORIGIN } from './ledger'

/**
 * Child process for the cross-process ledger test: reserve N attempts against a
 * synthetic ledger file and report how many were counted versus refused. It
 * never sends a request anywhere.
 */
const [ledgerPath, count] = process.argv.slice(2)
if (!ledgerPath || !count) throw new Error('Usage: ledger-child <ledgerPath> <attempts>')
const ledger = new ApiBudgetLedger({ origin: REMOTE_ORIGIN, max: REMOTE_MAX_API_REQUESTS, ledgerPath }, `child-${process.pid}`)
let reserved = 0
let exhausted = 0
let other = 0
for (let index = 0; index < Number(count); index++) {
  try {
    await ledger.reserve({ method: 'GET', path: '/api/health' })
    reserved++
  } catch (error) {
    if ((error as { code?: string }).code === 'BUDGET_EXHAUSTED') exhausted++
    else other++
  }
}
console.log(JSON.stringify({ pid: process.pid, reserved, exhausted, other }))
