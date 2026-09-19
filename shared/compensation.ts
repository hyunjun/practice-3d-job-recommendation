import { USD_RATES } from './types'
import type { CompensationRange, FactEvidence, Job, Salary } from './types'

export interface CompensationInput {
  label?: string | null
  min?: number | null
  max?: number | null
  currency?: string | null
  interval?: string | null
  basis?: CompensationRange['basis']
  scope?: string
  evidence?: FactEvidence
}

export type SalaryData = Pick<Job, 'salary' | 'compensationRanges' | 'compensationNote' | 'compensationEvidence'>

export function periodOf(interval?: string | null): CompensationRange['period'] {
  const value = interval?.trim().toLowerCase().replaceAll('_', '-')
  const periods: [CompensationRange['period'], RegExp][] = [
    ['year', /^(?:1 year|per-year(?:-salary)?|year|yearly|annual(?:ly)?)$/],
    ['month', /^(?:1 month|per-month(?:-salary)?|month|monthly)$/],
    ['week', /^(?:1 week|per-week(?:-salary)?|week|weekly)$/],
    ['day', /^(?:1 day|per-day(?:-salary)?|day|daily)$/],
    ['hour', /^(?:1 hour|per-hour(?:-salary)?|hour|hourly)$/],
  ]
  return periods.find(([, pattern]) => pattern.test(value ?? ''))?.[0] ?? 'unknown'
}

/** Location and the size of a number never establish a currency or annual pay period. */
export function normalizeCompensation(inputs: CompensationInput[]): SalaryData {
  const bounded = inputs.slice(0, 100)
  const invalid: CompensationInput[] = []
  const ranges = bounded.flatMap((input, index): CompensationRange[] => {
    if (typeof input.min !== 'number' || typeof input.max !== 'number'
      || !Number.isFinite(input.min) || !Number.isFinite(input.max)
      || input.min <= 0 || input.max < input.min) { invalid.push(input); return [] }
    const currency = typeof input.currency === 'string' && /^[A-Z]{3}$/i.test(input.currency.trim()) ? input.currency.trim().toUpperCase() : null
    return [{
      label: input.label?.trim().slice(0, 500) || (inputs.length > 1 ? `보상 구간 ${index + 1}` : '기본 급여'),
      min: input.min, max: input.max, currency, period: periodOf(input.interval), basis: input.basis ?? 'base',
      ...(input.scope ? { scope: input.scope.slice(0, 500) } : {}),
      ...(input.evidence ? { evidence: { ...input.evidence, text: input.evidence.text.slice(0, 2000) } } : {}),
    }]
  })
  const distinct = [...new Map(ranges.map(range => [JSON.stringify(range), range])).values()]
  const evidence = invalid.flatMap(input => input.evidence ? [input.evidence] : []).slice(0, 20)
  const evidenceData = evidence.length ? { compensationEvidence: evidence } : {}
  if (!distinct.length) return {
    salary: null, ...evidenceData,
    ...(inputs.length ? { compensationNote: '보상 설명은 있지만 비교할 수 있는 급여 범위를 확인하지 못했어요. 원문 근거를 확인해 주세요.' } : {}),
  }
  const variants = new Set(distinct.map(({ min, max, currency, period, basis }) => `${min}|${max}|${currency}|${period}|${basis}`))
  const first = distinct[0]
  const complete = ranges.length === inputs.length
  const scoped = distinct.some(range => range.scope)
  const allBase = distinct.every(range => range.basis === 'base')
  const knownCurrency = distinct.every(range => range.currency)
  const comparable = complete && variants.size === 1 && !scoped && allBase
    && first.period === 'year' && first.currency !== null && Object.hasOwn(USD_RATES, first.currency)
  let note = ''
  if (!complete) note = '일부 보상 구간의 금액을 확인할 수 없어요. 확인된 구간과 원문을 표시하며 연봉 비교에는 사용하지 않습니다.'
  else if (variants.size > 1) note = '지역·경력 등에 따라 보상 구간이 달라요. 각 조건을 확인할 수 있도록 나눠 표시하며 하나의 연봉으로 비교하지 않습니다.'
  else if (scoped) note = '특정 지역에 적용되는 보상입니다. 모든 근무지나 지원자에게 같은 금액이 적용된다고 가정하지 않고 연봉 비교에서 제외합니다.'
  else if (!allBase) note = '총보상이거나 기본 급여 여부가 확인되지 않은 금액입니다. 기본 연봉과 합쳐 비교하지 않습니다.'
  else if (!knownCurrency) note = '통화를 확정할 수 없어요. 근무지나 금액의 크기로 통화를 추정하지 않으며 연봉 비교에서 제외합니다.'
  else if (first.period !== 'year') note = first.period === 'unknown'
    ? '지급 기간이 확인되지 않은 금액입니다. 연봉으로 가정하지 않으며 원문 근거를 함께 표시합니다.'
    : '연간 급여로 명시되지 않은 보상입니다. 근무 시간과 지급 기간을 가정해 연봉으로 환산하지 않습니다.'
  else if (!comparable) note = '이 통화는 현재 연봉 비교에서 지원하지 않아요. 공고에 기재된 통화와 금액을 표시합니다.'
  return {
    salary: comparable ? { min: first.min, max: first.max, currency: first.currency as Salary['currency'] } : null,
    compensationRanges: distinct, ...evidenceData,
    ...(note ? { compensationNote: note } : {}),
  }
}
