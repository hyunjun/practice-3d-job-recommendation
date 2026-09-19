import { describe, expect, it } from 'vitest'
import { analyzeResume, extractYears } from '../../shared/profile'
import { formatExperienceYears } from '../../shared/job-qualifications'
import { filterJobs, matchJob } from '../../shared/matching'
import { DEFAULT_FILTERS, SAMPLE_PROFILE } from '../../shared/types'
import { normalizeJob } from '../../server/normalize'
import { searchCatalog, SEARCH_TIME } from '../fixtures/search-catalog'

const resume = 'Alex Example\nSoftware Engineer\nTypeScript와 Python으로 결제 서비스와 데이터 파이프라인을 개발했습니다.'
const job = normalizeJob({
  id: 2801, title: 'Backend Software Engineer', absolute_url: 'https://example.com/jobs/2801',
  location: { name: 'London, UK' },
  content: '<h2>Qualifications</h2><p>5 years of software engineering experience.</p><p>Experience using TypeScript.</p>',
}, 'search-fixture-a', SEARCH_TIME)!

describe('reviewable personal experience', () => {
  it.each([
    ['3.5 years of experience', 3.5],
    ['0.5년 경력', 0.5],
    ['개발 경력 7년', 7],
    ['5 years of software engineering experience', 5],
    ['5 years’ experience', 5],
    ['5+ years of experience', 5],
    ['총 경력 2년 6개월', 2.5],
    ['총경력2년6개월', 2.5],
    ['2년 6개월의 개발 경력', 2.5],
    ['18 months of experience', 1.5],
    ['Experience: 7 months', 7 / 12],
    ['Experience: 2 years and 7 months', 2 + 7 / 12],
    ['0 years of experience', 0],
    ['０．５년 경력', 0.5],
    ['50 years of experience', 50],
  ])('reads the complete duration in %s', (text, expected) => {
    expect(extractYears(text)).toBe(expected)
  })

  it.each([
    'Graduated in 2020. Developed a product in 2024.',
    '2019–2024 Software Engineer',
    '3-5 years of experience',
    '3.5–5.5 years of experience',
    '3‐5 years of experience',
    '3,5 years of experience',
    '3~5년 경력',
    'Less than 3 years of experience',
    '경력 3년 미만',
    '-3 years of experience',
    '100 years of experience',
    '2024 years of experience',
    'Python: 3 years of experience\nJava: 5 years of experience',
  ])('does not turn unclear or invalid durations into a total: %s', text => {
    expect(extractYears(text)).toBeNull()
  })

  it('prefers an explicit total, while conflicting totals remain unconfirmed', () => {
    expect(extractYears('Total experience: 7 years\nPython: 3 years of experience')).toBe(7)
    expect(extractYears('총 경력 7년\nPython 3년 경력')).toBe(7)
    expect(extractYears('Total experience: 7 years; Python: 3 years of experience')).toBe(7)
    expect(extractYears('3 years of Python experience; total experience: 7 years')).toBe(7)
    expect(extractYears('총 경력 7년, Python 3년 경력')).toBe(7)
    expect(extractYears('7 years of overall experience; Python: 3 years of experience')).toBe(7)
    expect(extractYears('7 years of TOTAL experience; Python: 3 years of experience')).toBe(7)
    expect(extractYears('Overall experience: 7 years\nTotal experience: 8 years')).toBeNull()
    expect(extractYears('3 years of experience\n3 years of experience')).toBe(3)
  })

  it('does not replace an ambiguous overall duration with a specific skill duration', () => {
    expect(extractYears('Total experience: 3–5 years; Python: 2 years of experience')).toBeNull()
    expect(extractYears('총 경력 3~5년, Python 2년 경력')).toBeNull()
    expect(extractYears('Experience: 3–5 years\nPython: 2 years of experience')).toBeNull()
    expect(extractYears('Total experience: 7 years; Python: 3–5 years of experience')).toBe(7)
  })

  it('keeps an absent duration separate from zero without inventing a default', () => {
    const unknown = analyzeResume(resume)
    expect(unknown.profile).toMatchObject({ kind: 'personal', years: null, skills: ['TypeScript', 'Python'] })
    expect(unknown.warnings.join(' ')).toContain('비워 두었어요')
    expect(analyzeResume(`${resume}\n0 years of experience`).profile.years).toBe(0)
    expect(analyzeResume(`${resume}\n0.5 years of experience`).profile.years).toBe(0.5)
  })

  it('formats fractional years without rounding them to a different duration', () => {
    expect(formatExperienceYears(0)).toBe('0년')
    expect(formatExperienceYears(3.5)).toBe('42개월')
    expect(formatExperienceYears(7 / 12)).toBe('7개월')
    expect(formatExperienceYears(0.1)).toBe('0.1년')
    expect(formatExperienceYears(0.01)).toBe('0.01년')
    expect(formatExperienceYears(5 - 3.3)).toBe('1.7년')
  })
})

describe('matching without personal experience', () => {
  it('uses skills and role without rewarding or penalizing unknown years, including jobs with unknown requirements', () => {
    const profile = { ...SAMPLE_PROFILE, skills: ['TypeScript'], years: null }
    const jobs = [null, 0, 3, 5, 10].map((minExperience, index) => ({ ...job, id: `${job.id}-${index}`, minExperience }))
    const results = jobs.map(item => matchJob(item, profile))
    expect(new Set(results.map(result => result.score)).size).toBe(1)
    for (const result of results) {
      expect(Number.isFinite(result.score)).toBe(true)
      expect(result.reasons.join(' ')).not.toMatch(/입력 경력|경력 \d/)
      expect(result.cautions.join(' ')).toContain('내 경력 연수가 미입력')
      expect(result.cautions.join(' ')).not.toContain('현재 입력한 경력보다')
      expect(result.cautions.join(' ')).not.toContain('전체 경력 연수만 비교합니다')
      expect(result.matchedSkills).toContain('TypeScript')
    }
    const catalog = searchCatalog(jobs)
    const ids = (years: number | null) => filterJobs(catalog, { ...profile, years }, DEFAULT_FILTERS).map(result => result.job.id).sort()
    expect(ids(null)).toEqual(ids(0))
    expect(ids(null)).toEqual(ids(5))
  })

  it('keeps zero and fractional inputs meaningful for actual requirement comparisons', () => {
    const profile = { ...SAMPLE_PROFILE, skills: ['TypeScript'] }
    expect(matchJob(job, { ...profile, years: 0 }).cautions).toContain('요구 경력 5년 · 현재 입력한 경력보다 5년 많아요')
    expect(matchJob(job, { ...profile, years: 3.5 }).cautions).toContain('요구 경력 5년 · 현재 입력한 경력보다 18개월 많아요')
    expect(matchJob(job, { ...profile, years: 3.3 }).cautions).toContain('요구 경력 5년 · 현재 입력한 경력보다 1.7년 많아요')
    expect(matchJob({ ...job, minExperience: 0.5 }, { ...profile, years: 0.5 }).reasons).toContain('입력 경력 6개월 · 공고에서 확인한 연수 하한 6개월')
  })
})
