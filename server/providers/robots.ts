import { BoardFetchError } from '../catalog-service'

interface Rule {
  allow: boolean
  tokens: string[]
  anchored: boolean
  specificity: number
}
export interface RobotsPolicy {
  rules: Rule[]
  crawlDelayMs: number
}
interface Group {
  agents: string[]
  rules: { allow: boolean; path: string }[]
  delays: string[]
  hasDirectives: boolean
}
const invalid = (): never => { throw new BoardFetchError('robots.txt의 접근 규칙을 확인하지 못했어요.') }

/** RFC 9309 comparison units: unreserved escapes decode, reserved escapes do not. */
function octets(value: string): string[] {
  const result: string[] = []
  for (let index = 0; index < value.length;) {
    const char = String.fromCodePoint(value.codePointAt(index)!)
    if (char === '%') {
      const hex = value.slice(index + 1, index + 3)
      if (!/^[a-f\d]{2}$/i.test(hex)) return invalid()
      const decoded = String.fromCharCode(Number.parseInt(hex, 16))
      result.push(/^[A-Za-z\d._~-]$/.test(decoded) ? decoded : `%${hex.toUpperCase()}`)
      index += 3
    } else {
      if (char.codePointAt(0)! < 128) result.push(char)
      else for (const byte of Buffer.from(char, 'utf8')) result.push(`%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
      index += char.length
    }
  }
  return result
}

/** No user-controlled regular expression or exponential wildcard expansion. */
function matches(rule: Rule, target: string[]): boolean {
  let pattern = 0
  let position = 0
  let star = -1
  let retry = 0
  while (position < target.length) {
    if (pattern === rule.tokens.length && !rule.anchored) return true
    if (rule.tokens[pattern] === '*') {
      star = pattern++
      retry = position
    } else if (rule.tokens[pattern] === target[position]) {
      pattern++
      position++
    } else if (star !== -1) {
      pattern = star + 1
      position = ++retry
    } else return false
  }
  while (rule.tokens[pattern] === '*') pattern++
  return pattern === rule.tokens.length
}

export function parseRobotsPolicy(text: string, productToken = 'OrbitCareerAtlas'): RobotsPolicy {
  if (Buffer.byteLength(text, 'utf8') > 512 * 1024
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return invalid()
  const groups: Group[] = []
  let group: Group | undefined
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n?|\n/)
  if (lines.length > 10_000) return invalid()
  for (const raw of lines) {
    const line = raw.split('#', 1)[0].trim()
    if (!line) continue
    if (/[<>]/.test(line)) return invalid()
    const colon = line.indexOf(':')
    if (colon < 1) return invalid()
    const key = line.slice(0, colon).trim().toLowerCase()
    // Unknown extension fields may be ignored only after validating the field
    // syntax. A text/plain JSON error is not an empty, permissive robots file.
    if (!/^[a-z][a-z\d_-]*$/.test(key)) return invalid()
    const value = line.slice(colon + 1).trim()
    if (key === 'user-agent') {
      if (!/^(?:\*|[A-Za-z\d_-]+)$/.test(value)) return invalid()
      if (!group || group.hasDirectives) {
        group = { agents: [], rules: [], delays: [], hasDirectives: false }
        groups.push(group)
      }
      group.agents.push(value.toLowerCase())
    } else if (key === 'allow' || key === 'disallow' || key === 'crawl-delay') {
      if (!group) return invalid()
      group.hasDirectives = true
      if (key === 'crawl-delay') group.delays.push(value)
      else if (value) group.rules.push({ allow: key === 'allow', path: value })
    }
    // Sitemap and other extension records neither grant access nor form a rule.
  }
  const token = productToken.toLowerCase()
  const specificity = (item: Group) => Math.max(0, ...item.agents.filter(agent => agent !== '*' && token.includes(agent)).map(agent => agent.length))
  const best = Math.max(0, ...groups.map(specificity))
  const selected = groups.filter(item => best ? specificity(item) === best : item.agents.includes('*'))
  const rules: Rule[] = []
  let crawlDelayMs = 0
  for (const item of selected) {
    for (const delay of item.delays) {
      if (!/^\d+(?:\.\d+)?$/.test(delay) || !Number.isFinite(Number(delay)) || Number(delay) > 60) {
        throw new BoardFetchError('robots.txt의 대기 간격이 수집 범위를 벗어났어요.')
      }
      crawlDelayMs = Math.max(crawlDelayMs, Number(delay) * 1000)
    }
    for (const rule of item.rules) {
      if (!rule.path.startsWith('/') || rule.path.length > 2048) return invalid()
      const anchored = rule.path.endsWith('$')
      const tokens = octets(anchored ? rule.path.slice(0, -1) : rule.path)
      rules.push({ allow: rule.allow, tokens, anchored, specificity: tokens.filter(value => value !== '*').length })
    }
  }
  return { rules, crawlDelayMs }
}

export function robotsAllows(policy: RobotsPolicy, path: string): boolean {
  if (!path.startsWith('/') || path.length > 4096) return false
  const target = octets(path)
  let best = -1
  let allowed = true
  for (const rule of policy.rules) {
    if (!matches(rule, target)) continue
    if (rule.specificity > best) {
      best = rule.specificity
      allowed = rule.allow
    } else if (rule.specificity === best && rule.allow) allowed = true
  }
  return allowed
}
