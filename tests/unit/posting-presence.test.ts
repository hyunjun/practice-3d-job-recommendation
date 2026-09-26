import { describe, expect, it } from 'vitest'
import { observeSavedPosting, PostingStatusIndexSchema } from '../../shared/posting-status'
import type { JobRevision } from '../../shared/posting-status'
import { presenceSaved } from '../fixtures/posting-presence'

// Literal synthetic revisions isolate the observation contract from the
// production revision generator. No implementation function computes an oracle.
const savedRevision: JobRevision = {
  title: 'a'.repeat(64), location: 'b'.repeat(64), conditions: 'c'.repeat(64),
  compensation: 'd'.repeat(64), qualifications: 'e'.repeat(64), description: 'f'.repeat(64), url: '0'.repeat(64),
}
const jobId = 'smartrecruiters-presence-harbour-59001'
const saved = presenceSaved()[0]
const current = {
  id: jobId, title: 'Staff Backend Engineer — Harbour Relay',
  url: 'https://example.com/jobs/presence-harbour-59001-current',
  revision: { ...savedRevision, title: '1'.repeat(64), description: '2'.repeat(64) },
}
function v2() {
  return {
    version: 2 as const, checkedAt: '2026-09-26T03:10:00.000Z',
    refreshAfter: '2026-09-26T03:11:00.000Z', contentRefreshAfter: '2026-09-26T03:01:00.000Z',
    boards: [{
      companyId: 'presence-harbour', provider: 'smartrecruiters' as const, board: 'HarbourPresence59',
      status: 'ok' as 'ok' | 'error', checkedAt: '2026-09-26T03:10:00.000Z',
      lastSuccessAt: '2026-09-26T03:10:00.000Z', retryAt: null,
      listing: {
        validUntil: '2026-09-26T03:40:00.000Z',
        publishedIds: [jobId, 'smartrecruiters-presence-harbour-59201'],
        jobs: [structuredClone(current)],
        content: {
          checkedAt: '2026-09-26T03:00:00.000Z',
          validUntil: '2026-09-26T03:30:00.000Z', status: 'ok' as 'ok' | 'error',
          jobIds: [jobId],
        },
      },
    }],
  }
}
function observe(input: unknown, now = '2026-09-26T03:10:00.000Z', record = saved) {
  return observeSavedPosting(record, PostingStatusIndexSchema.parse(input), savedRevision, Date.parse(now))
}

describe('independent posting-presence v2 schema contract', () => {
  it('accepts independent presence/content clocks without extending the content evidence window', () => {
    const parsed = PostingStatusIndexSchema.parse(v2())
    expect(parsed).toMatchObject({
      version: 2, contentRefreshAfter: '2026-09-26T03:01:00.000Z',
      boards: [{
        lastSuccessAt: '2026-09-26T03:10:00.000Z',
        listing: { validUntil: '2026-09-26T03:40:00.000Z', content: {
          checkedAt: '2026-09-26T03:00:00.000Z', validUntil: '2026-09-26T03:30:00.000Z', status: 'ok',
        } },
      }],
    })
  })

  it('accepts a cold complete inventory without requiring any normalized body', () => {
    const value = v2()
    const { content: _content, ...listing } = value.boards[0].listing
    const cold = { ...value, boards: [{ ...value.boards[0], listing: { ...listing, jobs: [] } }] }
    expect(PostingStatusIndexSchema.safeParse(cold).success).toBe(true)
    expect(observe(cold)).toMatchObject({ state: 'listed', checkedAt: '2026-09-26T03:10:00.000Z', contentState: 'unavailable' })
    expect(observe(cold).changedFields).toBeUndefined()
    expect(observe(cold).currentTitle).toBeUndefined()
  })

  it('requires an explicit content cooldown and never accepts v2 revision summaries without content evidence', () => {
    const value = v2()
    const { contentRefreshAfter: _cooldown, ...withoutCooldown } = value
    expect(PostingStatusIndexSchema.safeParse(withoutCooldown).success).toBe(false)
    const { content: _content, ...listing } = value.boards[0].listing
    expect(PostingStatusIndexSchema.safeParse({ ...value, boards: [{ ...value.boards[0], listing }] }).success).toBe(false)
  })

  it.each([
    ['zero content lifetime', { checkedAt: '2026-09-26T03:00:00.000Z', validUntil: '2026-09-26T03:00:00.000Z', status: 'ok' }],
    ['content lifetime over 30 minutes', { checkedAt: '2026-09-26T03:00:00.000Z', validUntil: '2026-09-26T03:30:00.001Z', status: 'ok' }],
    ['invalid content time', { checkedAt: 'not-an-iso-time', validUntil: '2026-09-26T03:30:00.000Z', status: 'ok' }],
    ['failed body evidence with current summaries', { checkedAt: '2026-09-26T03:00:00.000Z', validUntil: '2026-09-26T03:30:00.000Z', status: 'error' }],
  ])('rejects %s', (_label, content) => {
    const value = v2()
    expect(PostingStatusIndexSchema.safeParse({
      ...value, boards: [{ ...value.boards[0], listing: { ...value.boards[0].listing, content } }],
    }).success).toBe(false)
  })

  it('continues to reject duplicate, foreign and unsupported-version membership evidence', () => {
    const value = v2()
    expect(PostingStatusIndexSchema.safeParse({ ...value, version: 3 }).success).toBe(false)
    for (const publishedIds of [
      [jobId, jobId],
      [jobId, 'smartrecruiters-another-board-59201'],
      ['smartrecruiters-presence-harbour-59201'],
    ]) {
      expect(PostingStatusIndexSchema.safeParse({
        ...value, boards: [{ ...value.boards[0], listing: { ...value.boards[0].listing, publishedIds } }],
      }).success).toBe(false)
    }
  })
})

describe('independent user-observable presence/content states', () => {
  it('compares only the explicitly different title/body and preserves the saved original and its timestamps', () => {
    const before = structuredClone(saved)
    expect(observe(v2())).toMatchObject({
      state: 'listed', checkedAt: '2026-09-26T03:10:00.000Z',
      contentCheckedAt: '2026-09-26T03:00:00.000Z', contentState: 'checked',
      currentTitle: 'Staff Backend Engineer — Harbour Relay',
      currentUrl: 'https://example.com/jobs/presence-harbour-59001-current',
      changedFields: ['title', 'description'],
    })
    expect(saved).toEqual(before)
    expect(saved.job.title).toBe('Backend Engineer — Harbour Relay')
    expect(saved.job.description).toBe('Responsibilities\nBuild a fictional relay with TypeScript.\n\nMinimum requirements\n3 years of software engineering experience.')
    expect(saved.savedAt).toBe('2026-09-26T02:05:00.000Z')
  })

  it('expires body comparisons exactly at their own deadline while later presence evidence remains listed', () => {
    const before = observe(v2(), '2026-09-26T03:29:59.999Z')
    expect(before).toMatchObject({ state: 'listed', contentState: 'checked', changedFields: ['title', 'description'] })
    const expired = observe(v2(), '2026-09-26T03:30:00.000Z')
    expect(expired).toMatchObject({
      state: 'listed', checkedAt: '2026-09-26T03:10:00.000Z',
      contentState: 'stale', contentCheckedAt: '2026-09-26T03:00:00.000Z',
    })
    expect(expired.changedFields).toBeUndefined()
    expect(expired.currentTitle).toBeUndefined()
    expect(expired.message).toContain('내용')
    expect(observe(v2(), '2026-09-26T03:40:00.000Z').state).toBe('unknown')
  })

  it('retains an old body-check time without passing off empty comparison fields as a current match', () => {
    const value = v2()
    value.boards[0].listing.content.checkedAt = '2026-09-26T02:00:00.000Z'
    value.boards[0].listing.content.validUntil = '2026-09-26T02:30:00.000Z'
    value.boards[0].listing.jobs = []
    const observation = observe(value)
    expect(observation).toMatchObject({ state: 'listed', contentState: 'stale', contentCheckedAt: '2026-09-26T02:00:00.000Z' })
    expect(observation.changedFields).toBeUndefined()
    expect(observation.currentTitle).toBeUndefined()
  })

  it('does not compare a fresh body snapshot that is older than the saved source snapshot', () => {
    const newerSaved = { ...saved, job: { ...saved.job, fetchedAt: '2026-09-26T03:05:00.000Z' } }
    const observation = observe(v2(), '2026-09-26T03:10:00.000Z', newerSaved)
    expect(observation.state).toBe('listed')
    expect(observation.changedFields).toBeUndefined()
    expect(observation.currentTitle).toBeUndefined()
    expect(observation.message).toContain('내용')
  })

  it('a newly present ID missing from body summaries gets no comparison without a false out-of-scope claim', () => {
    const value = v2()
    value.boards[0].listing.jobs = []
    value.boards[0].listing.content.jobIds = []
    const observation = observe(value)
    expect(observation).toMatchObject({ state: 'listed', contentState: 'unavailable' })
    expect(observation.changedFields).toBeUndefined()
    expect(observation.currentTitle).toBeUndefined()
    expect(observation).not.toHaveProperty('contentCheckedAt', expect.any(String))
    expect(observation.message).toContain('내용')
    expect(observation.message).not.toContain('탐색 범위 밖')
  })

  it('never invents an individual body-check time or stale-body claim for an outside-scope ID', () => {
    const observation = observe(v2(), '2026-09-26T03:30:00.000Z', presenceSaved()[1])
    expect(observation).toMatchObject({ state: 'listed', contentState: 'unavailable' })
    expect(observation).not.toHaveProperty('contentCheckedAt', expect.any(String))
    expect(observation.changedFields).toBeUndefined()
    expect(observation.message).not.toContain('본문 확인 시각이 오래되어')
  })

  it('a failed full-body refresh leaves successful presence listed but makes content unavailable', () => {
    const value = v2()
    value.boards[0].listing.content.status = 'error'
    value.boards[0].listing.jobs = []
    const observation = observe(value)
    expect(observation).toMatchObject({
      state: 'listed', contentState: 'unavailable', contentCheckedAt: '2026-09-26T03:00:00.000Z',
    })
    expect(observation.changedFields).toBeUndefined()
    expect(observation.currentTitle).toBeUndefined()
  })

  it('a failed or partial inventory never infers absence from retained complete IDs', () => {
    const value = v2()
    value.boards[0].status = 'error'
    expect(observe(value)).toMatchObject({ state: 'unknown' })
    expect(observe(value, '2026-09-26T03:10:00.000Z', presenceSaved()[2])).toMatchObject({ state: 'unknown' })
    expect(observe(value).changedFields).toBeUndefined()
  })

  it('a complete inventory can report only missing-from-list, with an explicit source-check message', () => {
    const observation = observe(v2(), '2026-09-26T03:10:00.000Z', presenceSaved()[2])
    expect(observation).toMatchObject({
      state: 'missing', checkedAt: '2026-09-26T03:10:00.000Z',
      message: '최근 공개 목록에서 찾지 못했어요. 채용 종료 여부는 원문에서 확인해 주세요.',
    })
    expect(observation.changedFields).toBeUndefined()
  })

  it('v1 responses retain the legacy complete-body comparison and outside-scope semantics', () => {
    const value = v2()
    const { content: _content, ...listing } = value.boards[0].listing
    const legacy = {
      version: 1, checkedAt: '2026-09-26T03:10:00.000Z', refreshAfter: '2026-09-26T03:11:00.000Z',
      boards: [{ ...value.boards[0], listing }],
    }
    expect(observe(legacy)).toMatchObject({ state: 'listed', changedFields: ['title', 'description'] })
    expect(observe(legacy, '2026-09-26T03:10:00.000Z', presenceSaved()[1]).message).toContain('탐색 범위 밖')
    expect(observe(legacy, '2026-09-26T03:40:00.000Z').state).toBe('unknown')
  })
})
