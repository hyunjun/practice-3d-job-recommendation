import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { PUBLIC_COMPANIES } from '../shared/companies'
import { PUBLIC_PROVIDERS } from '../shared/types'
import type { Company } from '../shared/types'

const MAX_COMPANIES = 1000
const MAX_CONFIG_BYTES = 1024 * 1024
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u
const PALETTE = ['#a79aff', '#ff9c78', '#84dba6', '#91bafd', '#f7d878', '#83d1c7']
const DEFAULTS = new Map(PUBLIC_COMPANIES.map(company => [company.id, company]))

export class BoardConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BoardConfigurationError'
  }
}

const singleLine = (max: number) => z.string({ error: '문자열을 입력해 주세요.' })
  .refine(value => !CONTROL.test(value), '줄바꿈이나 제어 문자는 사용할 수 없어요.')
  .trim().min(1, '빈 값은 사용할 수 없어요.').max(max, `${max}자 이내로 입력해 주세요.`)
const CompanyId = singleLine(100).regex(/^[a-z0-9][a-z0-9-]*$/, '회사 ID는 소문자 영문·숫자·하이픈으로 입력해 주세요.')
const Registration = z.object({
  id: CompanyId,
  name: singleLine(200),
  industry: singleLine(200).optional(),
  provider: z.enum(PUBLIC_PROVIDERS, { error: '출처는 greenhouse, ashby, lever, smartrecruiters 중 하나여야 해요.' }),
  board: singleLine(200).refine(value => !/[/?#\\]/.test(value) && value !== '.' && value !== '..',
    '전체 URL 대신 게시판 이름 하나를 입력해 주세요. /, \\, ?, #은 사용할 수 없어요.'),
  boardRegion: z.literal('eu', { error: 'Lever EU 게시판에만 eu를 지정할 수 있어요.' }).optional(),
  careerUrl: singleLine(2000).refine(value => {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.username && !url.password
    } catch { return false }
  }, '계정 정보가 포함되지 않은 HTTPS 채용 페이지 주소를 입력해 주세요.'),
}).strict().superRefine((company, context) => {
  if (company.boardRegion && company.provider !== 'lever') {
    context.addIssue({ code: 'custom', path: ['boardRegion'], message: 'boardRegion은 Lever 게시판에만 지정할 수 있어요.' })
  }
})
const Configuration = z.object({
  version: z.literal(1, { error: '설정 형식 version은 1이어야 해요.' }),
  mode: z.enum(['extend', 'replace'], { error: 'mode는 extend 또는 replace여야 해요.' }).default('extend'),
  companies: z.array(z.unknown(), { error: 'companies에 회사 목록을 배열로 입력해 주세요.' })
    .max(MAX_COMPANIES, `회사 목록은 ${MAX_COMPANIES}개 이하여야 해요.`),
}).strict()

function parse<T extends z.ZodType>(schema: T, input: unknown, prefix = ''): z.output<T> {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  const messages = result.error.issues.slice(0, 5).map(issue => {
    let field = prefix
    for (const part of issue.path) {
      field += typeof part === 'number' ? `[${part}]` : `${field ? '.' : ''}${String(part).slice(0, 80)}`
    }
    const message = issue.code === 'unrecognized_keys'
      ? `알 수 없는 항목: ${issue.keys.slice(0, 5).map(key => JSON.stringify(key.slice(0, 80))).join(', ')}`
      : issue.message
    return `${field || '설정'}: ${message}`
  })
  throw new BoardConfigurationError(messages.join('\n'))
}

function registeredCompany(input: z.output<typeof Registration>): Company {
  const original = DEFAULTS.get(input.id)
  const words = input.name.split(/\s+/)
  const initials = words.slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase()
  let colorIndex = 0
  for (const letter of input.id) colorIndex = (colorIndex * 31 + letter.charCodeAt(0)) % PALETTE.length
  return {
    ...input,
    industry: input.industry ?? original?.industry ?? '공개 채용 게시판',
    initials: original?.name === input.name ? original.initials : initials,
    color: original?.color ?? PALETTE[colorIndex],
  }
}

export interface ParsedBoardConfiguration {
  mode: 'extend' | 'replace'
  companies: Company[]
}

/** Resolve public registrations without reading files or contacting providers. */
export function parseBoardConfiguration(input: unknown): ParsedBoardConfiguration {
  const parsed = parse(Configuration, input)
  const companies = new Map<string, Company>(parsed.mode === 'extend'
    ? PUBLIC_COMPANIES.map(company => [company.id, { ...company }]) : [])
  const explicitIds = new Set<string>()
  parsed.companies.forEach((entry, index) => {
    const field = `companies[${index}]`
    let company: Company
    if (typeof entry === 'string') {
      const id = parse(CompanyId, entry, field)
      const original = DEFAULTS.get(id)
      if (!original) throw new BoardConfigurationError(`${field}: 기본 목록에 없는 회사 ID "${id}"입니다. 회사 객체로 등록해 주세요.`)
      company = { ...original }
    } else {
      company = registeredCompany(parse(Registration, entry, field))
    }
    if (explicitIds.has(company.id)) throw new BoardConfigurationError(`${field}: 회사 ID "${company.id}"가 중복돼요.`)
    explicitIds.add(company.id)
    companies.set(company.id, company)
  })
  if (!companies.size || companies.size > MAX_COMPANIES) {
    throw new BoardConfigurationError(`companies: 적용할 회사는 1개 이상 ${MAX_COMPANIES}개 이하여야 해요.`)
  }
  const boards = new Map<string, string>()
  for (const company of companies.values()) {
    const key = JSON.stringify([company.provider ?? 'greenhouse', company.board, company.boardRegion ?? ''])
    const previous = boards.get(key)
    if (previous) throw new BoardConfigurationError(`companies: "${previous}"와 "${company.id}"가 같은 게시판을 가리켜요. 회사 하나로 등록해 주세요.`)
    boards.set(key, company.id)
  }
  return { mode: parsed.mode, companies: [...companies.values()] }
}

export interface BoardConfiguration {
  companies: Company[]
  mode: 'default' | ParsedBoardConfiguration['mode']
  filePath?: string
  cacheFile: string
  legacyCacheFiles: string[]
}

/** A configuration has its own cache, but can reuse source-matching default snapshots. */
export async function loadBoardConfiguration({
  cwd = process.cwd(), file = process.env.ORBIT_BOARDS_FILE,
}: { cwd?: string; file?: string } = {}): Promise<BoardConfiguration> {
  const defaultCache = path.resolve(cwd, '.local/public-board-cache-v5.json')
  const legacy = ['greenhouse-cache-v4.json', 'greenhouse-cache-v3.json'].map(name => path.resolve(cwd, '.local', name))
  if (file !== undefined && !file.trim()) throw new BoardConfigurationError('ORBIT_BOARDS_FILE에 설정 파일 경로를 입력해 주세요.')
  const requested = path.resolve(cwd, file ?? '.local/job-boards.json')
  let contents: Buffer
  let filePath: string
  let found = false
  try {
    const entry = await lstat(requested)
    found = true
    const info = entry.isSymbolicLink() ? await stat(requested) : entry
    if (!info.isFile()) throw new BoardConfigurationError('일반 JSON 파일을 지정해 주세요.')
    if (info.size > MAX_CONFIG_BYTES) throw new BoardConfigurationError('설정 파일은 1 MiB 이하여야 해요.')
    filePath = await realpath(requested)
    contents = await readFile(filePath)
    if (contents.length > MAX_CONFIG_BYTES) throw new BoardConfigurationError('설정 파일은 1 MiB 이하여야 해요.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && file === undefined && !found) {
      return { companies: PUBLIC_COMPANIES.map(company => ({ ...company })), mode: 'default', cacheFile: defaultCache, legacyCacheFiles: legacy }
    }
    const message = error instanceof BoardConfigurationError ? error.message
      : (error as NodeJS.ErrnoException).code === 'ENOENT' ? '설정 파일을 찾을 수 없어요. 경로를 확인해 주세요.'
        : '설정 파일을 읽을 수 없어요. 파일 경로와 읽기 권한을 확인해 주세요.'
    throw new BoardConfigurationError(`${JSON.stringify(requested)}: ${message}`)
  }
  let input: unknown
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents)) }
  catch { throw new BoardConfigurationError(`${JSON.stringify(requested)}: UTF-8 형식의 올바른 JSON 파일이어야 해요.`) }
  let parsed: ParsedBoardConfiguration
  try { parsed = parseBoardConfiguration(input) }
  catch (error) {
    if (!(error instanceof BoardConfigurationError)) throw error
    throw new BoardConfigurationError(`${JSON.stringify(requested)}:\n${error.message}`)
  }
  const key = createHash('sha256').update(filePath).digest('hex').slice(0, 16)
  return {
    ...parsed, filePath,
    cacheFile: path.resolve(cwd, `.local/configured-board-cache-v5-${key}.json`),
    legacyCacheFiles: [defaultCache, ...legacy],
  }
}
