import { ApiBudgetLedger, remoteConfigFromEnv } from './ledger'

/**
 * The approved owner's one-time ledger initialisation (ART82-5), bound in the
 * execution plan as the check that runs before the deployed read-only smoke. It
 * creates the persistent 60-attempt ledger exclusively at the runner-supplied
 * path and sends no request. An existing ledger is validated and left untouched
 * (idempotent reruns keep every charged attempt); a corrupt one fails this step.
 */
const config = remoteConfigFromEnv()
const owner = `ledger-init|${process.env.ORBIT_VERIFICATION_ACTOR ?? 'unknown-actor'}`
const result = await new ApiBudgetLedger(config, owner).initialize(owner)
console.log(JSON.stringify({
  ledgerPath: config.ledgerPath, origin: config.origin, max: config.max, created: result.created,
  initialized: result.file.initialized ?? null, attempts: result.file.attempts.length, remaining: config.max - result.file.attempts.length, requestsSent: 0,
}))
