import { createJobLanguagesServer } from './job-languages-server'
import {
  WORKPLACE_COUNTRY_REGISTRATIONS, workplaceCountryBaselineResponses, workplaceCountryResponses,
} from './workplace-countries'

// Reuse the existing upstream-only transport and owned-process/cache receipts.
// It accepts arbitrary fictional boards/responses; no language or country
// normalization is performed by this harness.
export async function createWorkplaceCountriesServer(
  directory: string,
  mode: 'development' | 'production',
  scenario: 'baseline' | 'complete' = 'complete',
) {
  const server = await createJobLanguagesServer(directory, mode, {
    companies: scenario === 'baseline' ? [WORKPLACE_COUNTRY_REGISTRATIONS[0]] : [...WORKPLACE_COUNTRY_REGISTRATIONS],
  })
  await server.respond(scenario === 'baseline' ? workplaceCountryBaselineResponses() : workplaceCountryResponses())
  return server
}
