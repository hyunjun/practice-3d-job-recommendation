// Stage 77 · fictional pay-context inputs and literal expectations. Every company,
// posting, sentence and amount below is invented. No product parser, normalizer or
// upgrader computes the expected strings here; they come from the approved contract
// (docs/design/compensation-context.md, draft02) and the existing product notes.
// Legacy pay shapes copy the literal defective outputs recorded in Main's baseline
// diagnostics for the a345ffa parser; they are inputs, not products of current code.
import type { GreenhouseJob } from '../../server/normalize'
import type { Company, Job } from '../../shared/types'

export const CONTEXT_TIME = '2026-10-01T09:00:00.000Z'

export const CONTEXT_COMPANY: Company = {
  id: 'fixture-quill-atlas', name: 'Quill Atlas Payroll', initials: 'QA', color: '#3974cc',
  industry: 'Synthetic pay-context verification', provider: 'greenhouse', board: 'fixture-quill-atlas',
  careerUrl: 'https://example.test/quill-atlas/careers',
}

export const CONTEXT_ASHBY_COMPANY: Company = {
  id: 'fixture-quill-harbor', name: 'Quill Harbor Systems', initials: 'QH', color: '#487950',
  industry: 'Synthetic structured-pay control', provider: 'ashby', board: 'fixture-quill-harbor',
  careerUrl: 'https://example.test/quill-harbor/careers',
}

/** Product notes quoted by the contract; tests pin them literally. */
export const CONTEXT_NOTES = {
  none: '보상 설명은 있지만 비교할 수 있는 급여 범위를 확인하지 못했어요. 원문 근거를 확인해 주세요.',
  partial: '일부 보상 구간의 금액을 확인할 수 없어요. 확인된 구간과 원문을 표시하며 연봉 비교에는 사용하지 않습니다.',
  variants: '지역·경력 등에 따라 보상 구간이 달라요. 각 조건을 확인할 수 있도록 나눠 표시하며 하나의 연봉으로 비교하지 않습니다.',
  scoped: '특정 지역에 적용되는 보상입니다. 모든 근무지나 지원자에게 같은 금액이 적용된다고 가정하지 않고 연봉 비교에서 제외합니다.',
  basis: '총보상이거나 기본 급여 여부가 확인되지 않은 금액입니다. 기본 연봉과 합쳐 비교하지 않습니다.',
  currency: '통화를 확정할 수 없어요. 근무지나 금액의 크기로 통화를 추정하지 않으며 연봉 비교에서 제외합니다.',
  periodUnknown: '지급 기간이 확인되지 않은 금액입니다. 연봉으로 가정하지 않으며 원문 근거를 함께 표시합니다.',
  notAnnual: '연간 급여로 명시되지 않은 보상입니다. 근무 시간과 지급 기간을 가정해 연봉으로 환산하지 않습니다.',
  legacy: '이전 형식으로 저장된 금액입니다. 지급 기간과 적용 조건은 원문에서 다시 확인해 주세요.',
  unverifiable: '이전 조회 본문에서 보상 근거를 다시 확인하지 못했어요. 원문을 확인해 주세요.',
  other: '기본급 외 보상 항목입니다. 기본 연봉 비교에는 사용하지 않습니다.',
  incompleteOther: '기본급 외 보상 일부의 금액을 확인할 수 없어요. 기본 급여와 해당 원문 근거를 함께 표시합니다.',
  demoted: '이전 게시판 보상의 기간·구성 근거가 충분하지 않아 확인된 금액과 원문만 유지합니다.',
} as const

/** Default explanation shown when a comparable job has no compensation note. */
export const CONTEXT_DEFAULT_NOTE = '공고에서 확인한 급여 구간입니다. 보너스·주식은 기본 연봉에 합산하지 않았어요.'
export const OTHER_SUFFIX = ' · 기본급 외 보상'

export const CONTEXT_INTRO = 'Five years of backend engineering with TypeScript and PostgreSQL.'

export const CONTEXT_SENTENCES = {
  bonusOnly: 'Annual base salary is competitive, plus a signing bonus of USD 25,000.',
  bonusAfterBase: 'Annual base salary: USD 100,000–120,000, plus a signing bonus of USD 25,000.',
  postfixBonus: 'Annual base salary: USD 100,000–120,000 and a USD 25,000 signing bonus.',
  bonusFirst: 'A signing bonus of USD 25,000, plus annual base salary USD 100,000–120,000.',
  reviewedAnnually: 'Base salary: USD 130,000–170,000, reviewed annually.',
  reviewedMonthly: 'Annual base salary: EUR 90,000–110,000, reviewed monthly.',
  currencyLeak: 'Annual base salary: $120,000–$180,000 plus a signing bonus of CAD 20,000.',
  reviewLabel: 'Annual salary reviews: USD 100,000–120,000.',
  incompleteBase: 'Annual base salary up to USD 180,000.',
  legitimateUnknown: 'Base salary: EUR 90,000–110,000, reviewed annually.',
  /** A benefits list with no salary subject; not an apparent salary disclosure. */
  benefitsBonus: 'Benefits\n- Signing bonus: USD 25,000 for new hires\n- Remote equipment budget',
  /** Astra T17/H01: the inclusion predicate belongs to benefits, not to the salary amount. */
  benefitsInclude: 'Annual base salary is competitive and benefits include a signing bonus of USD 25,000.',
  /** Astra M01: a malformed salary beside a bonus whose number equals an old valid candidate. */
  malformedWithEqualBonus: 'Annual base salary: EUR 20.000. Signing bonus: USD 20,000.',
  /** Astra M02: ordinary stage76 numeric recovery must survive an unrelated rejected bonus. */
  spaceGroupedWithBonus: 'Annual base salary: EUR 84 000–126 000 and a signing bonus of USD 25,000.',
  /** Astra T11: an immediate annual heading above a same-band reference point. */
  headingReference: 'Annual base salary by location\nCanada: $120,000–$180,000 (accomplished: ~$145,000 CAD)',
  /** Astra T05: an explicitly owned currency heading above a bare dollar range. */
  headingCurrency: 'Annual base salary (USD)\n$100,000–$120,000',
  /** Astra B02: the numeric object of an included bonus, component noun before and after the amount. */
  includesBonusOf: 'Compensation also includes a signing bonus of USD 20,000.',
  includesBonusPostfix: 'Compensation also includes a USD 20,000 signing bonus.',
  /** Astra B03: the monetary object inside an exclusion, component noun before the amount. */
  excludesBonusOf: 'Annual base salary excludes a signing bonus of USD 20,000.',
  /** Main's D.C. observation rewritten with invented wording and amounts. */
  dcScope: 'For Washington D.C. based hires: Estimated annual salary of USD 112,000–146,000.',
  /** H1: a pay heading above a seniority-abbreviated role line in the historical shape (trailing heading space, bare dollars, cents, "/per year"). */
  seniorHeading: 'Pay range: \nSr. Orbit Systems Engineer: $140,000.00 - $190,000.00/per year',
  /** H1: an explicit annual base heading above the same abbreviated role line. */
  seniorBaseHeading: 'Annual base salary range:\nSr. Orbit Systems Engineer: USD 100,000–120,000',
  /** H1: the abbreviation inside the owning annual base phrase itself. */
  seniorInlineBase: 'Annual base salary for a Sr. Orbit Systems Engineer: USD 100,000–120,000.',
  /** H1 boundary controls: a real full stop or semicolon still separates the Sr. bonus clause from the base range. */
  seniorBonusSentence: 'Annual base salary: USD 100,000–120,000. Sr. engineers receive a signing bonus of USD 25,000.',
  seniorBonusSemicolon: 'Annual base salary: USD 100,000–120,000; Sr. engineers receive a signing bonus of USD 25,000.',
  seniorBonusFirst: 'Sr. engineers receive a signing bonus of USD 25,000. Annual base salary: USD 100,000–120,000.',
  /** Astra R01 guard for H1: an earlier competitive-salary sentence lends no public evidence to a later Sr. bonus clause. */
  seniorRejectionOnly: 'Annual base salary is competitive. Sr. Platform Engineer signing bonus: USD 25,000.',
} as const

/** Astra M06: a native board disclosure whose second item has no title, blurb or bounds. */
export const CONTEXT_INCOMPLETE_RANGES: NonNullable<GreenhouseJob['pay_input_ranges']> = [
  { title: 'Annual base salary', min_cents: 10000000, max_cents: 12000000, currency_type: 'USD' },
  { max_cents: 2500000, currency_type: 'USD' },
]

/** A complete owned Greenhouse base row as stored by earlier versions. */
export const CONTEXT_BOARD_COMPLETE_ROW: NonNullable<Job['compensationRanges']>[number] = {
  label: 'Annual base salary', min: 100000, max: 120000, currency: 'USD', period: 'year', basis: 'base',
  evidence: { source: 'board', text: 'Annual base salary\nThe annual base salary range for this role is listed below.' },
}

/** A Greenhouse posting whose compensation comes only from structured board ranges. */
export function contextBoardRaw(id: number, title: string, ranges: NonNullable<GreenhouseJob['pay_input_ranges']>): GreenhouseJob {
  return {
    id, title, absolute_url: `https://example.test/quill-atlas/jobs/${id}`, location: { name: 'London, UK' },
    metadata: [{ name: 'Workplace Type', value: 'Hybrid' }],
    content: [CONTEXT_INTRO, 'Compensation details are provided by the board disclosure below.'].map(paragraph => `<p>${paragraph}</p>`).join(''),
    pay_input_ranges: ranges,
  }
}

/** Board quotes as Greenhouse stores them: title, newline, blurb. */
export const CONTEXT_BOARD_QUOTES = {
  reviewedAnnually: 'Salary Range\nBase salary is reviewed annually.',
  annualTitleMonthlyReview: 'Annual base salary\nBase salary is reviewed monthly.',
  completeAnnual: 'Annual base salary\nThe annual base salary range for this role is listed below.',
} as const

export interface ContextPosting {
  id: number
  title: string
  /** Search text that isolates this posting in the discovery panel. */
  search: string
  /** Body paragraphs after the shared intro; each becomes its own line. */
  paragraphs: string[]
  payInputRanges?: NonNullable<GreenhouseJob['pay_input_ranges']>
}

export const CONTEXT_STRUCTURED_RANGES: NonNullable<GreenhouseJob['pay_input_ranges']> = [
  { title: 'Annual base salary', min_cents: 10000000, max_cents: 12000000, currency_type: 'USD', blurb: 'Paid in twelve monthly installments.' },
  { title: 'Signing bonus', min_cents: 2500000, max_cents: 2500000, currency_type: 'USD', blurb: 'We also offer a competitive annual base salary.' },
]

export const CONTEXT_POSTINGS = {
  bonusAfterBase: {
    id: 7701, title: 'Backend Engineer — bonus after base fixture', search: 'bonus after base',
    paragraphs: [CONTEXT_SENTENCES.bonusAfterBase],
  },
  bonusOnly: {
    id: 7702, title: 'Backend Engineer — bonus only fixture', search: 'bonus only',
    paragraphs: [CONTEXT_SENTENCES.bonusOnly],
  },
  bonusFirst: {
    id: 7703, title: 'Backend Engineer — bonus first fixture', search: 'bonus first',
    paragraphs: [CONTEXT_SENTENCES.bonusFirst],
  },
  reviewedAnnually: {
    id: 7704, title: 'Backend Engineer — reviewed annually fixture', search: 'reviewed annually',
    paragraphs: [CONTEXT_SENTENCES.reviewedAnnually],
  },
  reviewedMonthly: {
    id: 7705, title: 'Backend Engineer — reviewed monthly fixture', search: 'reviewed monthly',
    paragraphs: [CONTEXT_SENTENCES.reviewedMonthly],
  },
  structured: {
    id: 7706, title: 'Backend Engineer — structured base and other fixture', search: 'structured base',
    paragraphs: ['Compensation details are provided by the board disclosure below.'],
    payInputRanges: CONTEXT_STRUCTURED_RANGES,
  },
  currencyLeak: {
    id: 7707, title: 'Backend Engineer — currency leak fixture', search: 'currency leak',
    paragraphs: [CONTEXT_SENTENCES.currencyLeak],
  },
} satisfies Record<string, ContextPosting>

export type ContextPostingKey = keyof typeof CONTEXT_POSTINGS

export function contextPostingRaw(key: ContextPostingKey): GreenhouseJob {
  const { id, title, paragraphs, payInputRanges } = CONTEXT_POSTINGS[key] as ContextPosting
  return {
    id, title, absolute_url: `https://example.test/quill-atlas/jobs/${id}`, location: { name: 'London, UK' },
    metadata: [{ name: 'Workplace Type', value: 'Hybrid' }],
    content: [CONTEXT_INTRO, ...paragraphs].map(paragraph => `<p>${paragraph}</p>`).join(''),
    ...(payInputRanges ? { pay_input_ranges: payInputRanges } : {}),
  }
}

type LegacyPay = Pick<Job, 'salary' | 'compensationRanges' | 'compensationEvidence' | 'compensationNote'>

/**
 * Hand-written version 3 outputs shaped like the recorded a345ffa results: a signing
 * bonus promoted to annual base salary, a bonus appended as a second base row, a review
 * cadence lending a year, and a Greenhouse blurb cadence lending a year.
 */
/**
 * Hand-written version 2 description rows shaped like stage76-era defects: a dotted
 * ambiguous amount read as a whole number next to an equal-valued bonus, and a
 * space-grouped range truncated to its first groups. Literal inputs only.
 */
export const CONTEXT_LEGACY_ROWS = {
  malformedEqualBonus: {
    label: 'Annual base salary', min: 20000, max: 20000, currency: 'EUR', period: 'year', basis: 'base',
    evidence: { source: 'description', text: CONTEXT_SENTENCES.malformedWithEqualBonus },
  },
  spaceGroupedBonus: {
    label: 'Annual base salary', min: 84, max: 126, currency: 'EUR', period: 'year', basis: 'base',
    evidence: { source: 'description', text: CONTEXT_SENTENCES.spaceGroupedWithBonus },
  },
  equalValidSalaryBonus: {
    label: 'Annual base salary', min: 25000, max: 25000, currency: 'USD', period: 'year', basis: 'base',
    evidence: { source: 'description', text: 'Annual base salary: USD 25,000. Signing bonus: USD 25,000.' },
  },
  /** H1: a retained quote and label that already lost the Sr. qualifier, as the unexecuted candidate stored them. */
  seniorStaleQuote: {
    label: 'Orbit Systems Engineer', min: 140000, max: 190000, currency: null, period: 'year', basis: 'unknown',
    evidence: { source: 'description', text: 'Pay range:\nOrbit Systems Engineer: $140,000.00 - $190,000.00/per year' },
  },
} satisfies Record<string, NonNullable<Job['compensationRanges']>[number]>

export const CONTEXT_LEGACY_PAY: Record<'bonusOnly' | 'twoRows' | 'reviewedAnnually' | 'greenhouseReview' | 'greenhouseMonthlyReview', LegacyPay> = {
  bonusOnly: {
    salary: { min: 25000, max: 25000, currency: 'USD' },
    compensationRanges: [{
      label: 'Annual base salary is competitive, plus a signing bonus of', min: 25000, max: 25000, currency: 'USD', period: 'year', basis: 'base',
      evidence: { source: 'description', text: CONTEXT_SENTENCES.bonusOnly },
    }],
  },
  twoRows: {
    salary: null,
    compensationRanges: [
      {
        label: 'Annual base salary', min: 100000, max: 120000, currency: 'USD', period: 'year', basis: 'base',
        evidence: { source: 'description', text: CONTEXT_SENTENCES.postfixBonus },
      },
      {
        label: 'and a', min: 25000, max: 25000, currency: 'USD', period: 'year', basis: 'base',
        evidence: { source: 'description', text: CONTEXT_SENTENCES.postfixBonus },
      },
    ],
    compensationNote: CONTEXT_NOTES.variants,
  },
  reviewedAnnually: {
    salary: { min: 130000, max: 170000, currency: 'USD' },
    compensationRanges: [{
      label: 'Base salary', min: 130000, max: 170000, currency: 'USD', period: 'year', basis: 'base',
      evidence: { source: 'description', text: CONTEXT_SENTENCES.reviewedAnnually },
    }],
  },
  greenhouseReview: {
    salary: { min: 100000, max: 120000, currency: 'USD' },
    compensationRanges: [{
      label: 'Salary Range', min: 100000, max: 120000, currency: 'USD', period: 'year', basis: 'base',
      evidence: { source: 'board', text: CONTEXT_BOARD_QUOTES.reviewedAnnually },
    }],
  },
  greenhouseMonthlyReview: {
    salary: null,
    compensationRanges: [{
      label: 'Annual base salary', min: 100000, max: 120000, currency: 'USD', period: 'unknown', basis: 'base',
      evidence: { source: 'board', text: CONTEXT_BOARD_QUOTES.annualTitleMonthlyReview },
    }],
    compensationNote: CONTEXT_NOTES.periodUnknown,
  },
}

/** A board quote at the 2,000-character storage cap, starting with an intact title and neutral filler. */
export function cappedBoardQuote(title: string): string {
  const filler = 'The employer retained further explanatory text here. '
  return `${title}\n${filler.repeat(60)}`.slice(0, 2000)
}

/** Fictional Himalayas feed record. The body decides whether the API amounts are used. */
export function quillAtlasHimalayasRaw(overrides: Record<string, unknown> = {}) {
  return {
    guid: 'https://himalayas.app/companies/quill-atlas/jobs/synthetic-context-77',
    companySlug: 'quill-atlas', companyName: 'Quill Atlas Payroll',
    title: 'Backend Engineer — Synthetic Context 77',
    description: `<p>${CONTEXT_INTRO}</p>`,
    employmentType: 'Full Time', locationRestrictions: [], timezoneRestrictions: [],
    minSalary: 150000, maxSalary: 180000, currency: 'USD', salaryPeriod: 'year',
    pubDate: 1790726400, expiryDate: 1796083200,
    ...overrides,
  }
}
