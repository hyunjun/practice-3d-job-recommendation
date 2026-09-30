// Stage 76 · fictional pay-format inputs and literal expectations. Every company,
// posting, sentence and amount below is invented. No product parser, normalizer or
// upgrader computes the expected strings here; they come from the agreed contract
// (docs/design/compensation-number-format.md) and the existing product notes.
import type { Company, Job } from '../../shared/types'

export const NUMBER_FORMAT_TIME = '2026-10-01T07:00:00.000Z'

export const NUMBER_FORMAT_COMPANY: Company = {
  id: 'fixture-quill-ledger', name: 'Quill Ledger Systems', initials: 'QL', color: '#3974cc',
  industry: 'Synthetic pay-format verification', provider: 'greenhouse', board: 'fixture-quill-ledger',
  careerUrl: 'https://example.test/quill-ledger/careers',
}

export const NUMBER_FORMAT_ASHBY_COMPANY: Company = {
  id: 'fixture-quill-studio', name: 'Quill Studio Collective', initials: 'QS', color: '#487950',
  industry: 'Synthetic structured-pay verification', provider: 'ashby', board: 'fixture-quill-studio',
  careerUrl: 'https://example.test/quill-studio/careers',
}

/** Existing product notes quoted by the contract; tests pin them literally. */
export const NUMBER_FORMAT_NOTES = {
  none: '보상 설명은 있지만 비교할 수 있는 급여 범위를 확인하지 못했어요. 원문 근거를 확인해 주세요.',
  partial: '일부 보상 구간의 금액을 확인할 수 없어요. 확인된 구간과 원문을 표시하며 연봉 비교에는 사용하지 않습니다.',
  basis: '총보상이거나 기본 급여 여부가 확인되지 않은 금액입니다. 기본 연봉과 합쳐 비교하지 않습니다.',
  legacy: '이전 형식으로 저장된 금액입니다. 지급 기간과 적용 조건은 원문에서 다시 확인해 주세요.',
  periodUnknown: '지급 기간이 확인되지 않은 금액입니다. 연봉으로 가정하지 않으며 원문 근거를 함께 표시합니다.',
  notAnnual: '연간 급여로 명시되지 않은 보상입니다. 근무 시간과 지급 기간을 가정해 연봉으로 환산하지 않습니다.',
} as const

export const NUMBER_FORMAT_INTRO = '5 years of software engineering with Python and AWS.'

export interface NumberFormatPosting {
  id: number
  title: string
  /** Search text that isolates this posting in the discovery panel. */
  search: string
  /** Body paragraphs after the shared intro; each becomes its own line. */
  paragraphs: string[]
}

export const NUMBER_FORMAT_POSTINGS = {
  spaceGrouped: {
    id: 7601, title: 'Backend Engineer — space grouped pay fixture', search: 'space grouped',
    paragraphs: ['Annual base salary: €88 000 – €124 000.'],
  },
  dotted: {
    id: 7602, title: 'Backend Engineer — dotted ambiguity fixture', search: 'dotted ambiguity',
    paragraphs: ['Compensation range', '62.000 - 118.000 EUR gross annually'],
  },
  annotated: {
    id: 7603, title: 'Backend Engineer — annotated malformed range fixture', search: 'annotated malformed',
    paragraphs: ['The base pay for this position ranges from USD 84,00/year to USD 126,000/year.'],
  },
  mixed: {
    id: 7604, title: 'Backend Engineer — mixed region rows fixture', search: 'mixed region',
    paragraphs: [
      'For Portugal based hires: Annual base salary EUR 54.000–91.000.',
      'For Colorado based hires: Annual base salary USD 136,000–187,000.',
    ],
  },
  bullets: {
    id: 7605, title: 'Backend Engineer — numeric bullets fixture', search: 'numeric bullets',
    paragraphs: ['Annual base salary: USD 150,000', '- 4 weeks of vacation', '- 401(k) match'],
  },
} satisfies Record<string, NumberFormatPosting>

export type NumberFormatPostingKey = keyof typeof NUMBER_FORMAT_POSTINGS

/**
 * Second-pass postings shaped like two actual-data structures reported during the
 * product review: a whitespace-separated dash after an existing city label, and a
 * range whose endpoints each carry a trailing currency code. Fictional amounts.
 */
export const NUMBER_FORMAT_LABEL_POSTINGS = {
  cityLabel: {
    id: 7606, title: 'Backend Engineer — city label pay fixture', search: 'city label',
    paragraphs: ['Salary Range : Paris - Base Annual Gross - 51,000€ to 76,000€'],
  },
  trailingCurrency: {
    id: 7607, title: 'Backend Engineer — trailing currency monthly fixture', search: 'trailing currency',
    paragraphs: ['Monthly salary range: 29,000 PLN - 32,900 PLN per month.'],
  },
} satisfies Record<string, NumberFormatPosting>

export const NUMBER_FORMAT_LABEL_QUOTES = {
  cityLabel: 'Salary Range : Paris - Base Annual Gross - 51,000€ to 76,000€',
  trailingCurrency: 'Monthly salary range: 29,000 PLN - 32,900 PLN per month.',
} as const

export const NUMBER_FORMAT_QUOTES = {
  spaceGrouped: 'Annual base salary: €88 000 – €124 000.',
  dotted: '62.000 - 118.000 EUR gross annually',
  annotated: 'The base pay for this position ranges from USD 84,00/year to USD 126,000/year.',
  portugal: 'For Portugal based hires: Annual base salary EUR 54.000–91.000.',
  colorado: 'For Colorado based hires: Annual base salary USD 136,000–187,000.',
} as const

/**
 * Hand-written version 2 outputs shaped like the preserved defective records:
 * the truncated first group of a space-grouped range, and the dotted range read
 * as small decimals. They are literal inputs, not products of the current parser.
 */
export const NUMBER_FORMAT_LEGACY_PAY: Record<'spaceGrouped' | 'dotted', Pick<Job, 'salary' | 'compensationRanges' | 'compensationEvidence' | 'compensationNote'>> = {
  spaceGrouped: {
    salary: null,
    compensationRanges: [{
      label: 'Annual base salary', min: 88, max: 88, currency: 'EUR', period: 'year', basis: 'base',
      evidence: { source: 'description', text: NUMBER_FORMAT_QUOTES.spaceGrouped },
    }],
    compensationEvidence: [{ source: 'description', text: NUMBER_FORMAT_QUOTES.spaceGrouped }],
    compensationNote: NUMBER_FORMAT_NOTES.partial,
  },
  dotted: {
    salary: null,
    compensationRanges: [{
      label: 'Compensation range', min: 62, max: 118, currency: 'EUR', period: 'year', basis: 'unknown',
      evidence: { source: 'description', text: `${NUMBER_FORMAT_INTRO}\nCompensation range\n${NUMBER_FORMAT_QUOTES.dotted}` },
    }],
    compensationNote: NUMBER_FORMAT_NOTES.basis,
  },
}

/** Fictional Himalayas feed record. The body decides whether the API amounts are used. */
export function quillHimalayasRaw(overrides: Record<string, unknown> = {}) {
  return {
    guid: 'https://himalayas.app/companies/quill-ledger/jobs/synthetic-number-format-76',
    companySlug: 'quill-ledger', companyName: 'Quill Ledger Systems',
    title: 'Backend Engineer — Synthetic Number Format 76',
    description: '<p>Build a fictional ledger API with TypeScript.</p>',
    employmentType: 'Full Time', locationRestrictions: [], timezoneRestrictions: [],
    minSalary: 150000, maxSalary: 180000, currency: 'USD', salaryPeriod: 'year',
    pubDate: 1790726400, expiryDate: 1796083200,
    ...overrides,
  }
}
