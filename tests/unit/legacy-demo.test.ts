import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createLegacyDemoCatalog } from '../fixtures/legacy-demo'

describe('frozen authored data for legacy compatibility regressions', () => {
  it('preserves all original company, job and city metadata independently of active registrations', () => {
    const historical = createLegacyDemoCatalog()
    expect(historical.companies).toHaveLength(32)
    expect(historical.jobs).toHaveLength(179)
    expect(historical.cities).toHaveLength(22)
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    expect(hash(historical.companies)).toBe('4183aebca1efdbd2fe657cb6dee079912eed89ca0040b6abf52b87e440372bce')
    expect(hash(historical.jobs)).toBe('2bcf5df651ceb5a464c30f3dfa285257d77e75ea32443ef7c4738d4cbe4c9168')
    expect(hash(historical.cities)).toBe('f6ff919107cfd2d1b8469d06ba5780a91707567b160acd393fb14cf70f5891a5')
    expect(historical.source).toBe('sample')
    expect(historical.jobs.every(job => job.source === 'sample')).toBe(true)
  })
})
