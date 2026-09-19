import { normalizeCompensation } from '../shared/compensation'
import { parseTextCompensation, payBasis, payPeriod, payScope } from '../shared/pay-text'
import { plainText } from '../shared/text'
import type { GreenhouseJob } from './normalize'

export function greenhouseCompensation(text: string, ranges?: GreenhouseJob['pay_input_ranges']) {
  if (!Array.isArray(ranges) || !ranges.length) return parseTextCompensation(text)
  return normalizeCompensation(ranges.map(range => {
    const title = typeof range.title === 'string' ? plainText(range.title) : ''
    const blurb = typeof range.blurb === 'string' ? plainText(range.blurb) : ''
    const context = [title, blurb].filter(Boolean).join('\n')
    const titleBasis = payBasis(title)
    const scope = payScope(context)
    return {
      min: typeof range.min_cents === 'number' ? range.min_cents / 100 : null,
      max: typeof range.max_cents === 'number' ? range.max_cents / 100 : null,
      currency: range.currency_type ?? range.currency_code,
      label: title || '게시판의 급여 범위',
      interval: payPeriod(context),
      basis: titleBasis === 'unknown' ? payBasis(blurb) : titleBasis,
      ...(scope ? { scope } : {}),
      ...(context ? { evidence: { source: 'board' as const, text: context.slice(0, 2000) } } : {}),
    }
  }))
}
