import { USD_RATES } from '../shared/types'
import type { CompensationRange, Job, Salary } from '../shared/types'

export interface CompensationInput {
  label?: string | null
  min?: number | null
  max?: number | null
  currency?: string | null
  interval?: string | null
}

export type SalaryData = Pick<Job, 'salary' | 'compensationRanges' | 'compensationNote'>

function periodOf(interval?: string | null): CompensationRange['period'] {
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

/** Keep conditional offers separate. Only an identical annual range is comparable across tiers. */
export function normalizeCompensation(inputs: CompensationInput[]): SalaryData {
  const ranges = inputs.flatMap((input, index): CompensationRange[] => {
    if (typeof input.min !== 'number' || typeof input.max !== 'number'
      || !Number.isFinite(input.min) || !Number.isFinite(input.max)
      || input.min <= 0 || input.max < input.min || !/^[A-Z]{3}$/i.test(input.currency ?? '')) return []
    return [{
      label: input.label?.trim().slice(0, 500) || (inputs.length > 1 ? `보상 구간 ${index + 1}` : '기본 급여'),
      min: input.min, max: input.max, currency: input.currency!.toUpperCase(), period: periodOf(input.interval),
    }]
  })
  const distinct = [...new Map(ranges.map(range => [JSON.stringify(range), range])).values()]
  if (!distinct.length) return {
    salary: null,
    ...(inputs.length ? { compensationNote: '공개된 보상 정보에서 유효한 급여 범위를 확인하지 못했어요. 원문을 확인해 주세요.' } : {}),
  }
  const variants = new Set(distinct.map(({ min, max, currency, period }) => `${min}|${max}|${currency}|${period}`))
  const first = distinct[0]
  const complete = ranges.length === inputs.length
  const comparable = complete && variants.size === 1 && first.period === 'year' && Object.hasOwn(USD_RATES, first.currency)
  return {
    salary: comparable ? { min: first.min, max: first.max, currency: first.currency as Salary['currency'] } : null,
    compensationRanges: distinct,
    ...(!comparable ? {
      compensationNote: !complete
        ? '일부 보상 구간은 금액이나 통화를 확인할 수 없어요. 확인된 구간만 표시하며 연봉 비교에는 사용하지 않습니다.'
        : variants.size > 1
          ? '지역·경력 등에 따라 보상 구간이 달라요. 각 조건을 확인할 수 있도록 나눠 표시하며 하나의 연봉으로 비교하지 않습니다.'
          : first.period !== 'year'
            ? '연간 급여로 명시되지 않은 보상입니다. 근무 시간과 지급 기간을 가정해 연봉으로 환산하지 않습니다.'
            : '이 통화는 현재 연봉 비교에서 지원하지 않아요. 공고에 기재된 통화와 금액을 표시합니다.',
    } : {}),
  }
}
