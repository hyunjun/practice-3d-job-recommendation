import { POSTING_PURPOSE_VERSION } from './types'
import type { Job, JobPostingPurpose } from './types'

const REGISTRATION_TITLE = /\b(?:expression of interest|talent (?:pool|community)|general application|future (?:opportunities|roles))\b|인재\s*풀|채용\s*관심\s*등록/i
const EXAMPLE = /\b(?:for example|for instance|e\.g\.|sample (?:text|message|posting)|template|quoted? (?:text|example))\b|예를\s*들어|예시|샘플\s*(?:문구|공고)|서식\s*예/i
const SUBJECT = /^(?:(?:please note|note)\s*[:,—-]?\s*)?(?:this|our)\s+(?:(?:job|career)\s+)?(?:posting|post|advertisement|application|registration|page)\b/i
const POOL_DEFINITION = /^(?:(?:please note|note)\s*[:,—-]?\s*)?(?:this|our\s+(?:(?:job|career)\s+)?(?:posting|post|application|registration|page)|this\s+(?:(?:job|career)\s+)?(?:posting|post|application|registration|page))\s+(?:is|serves as)\s+(?:(?:only|solely)\s+)?(?:for\s+)?(?:(?:a|an|our|the)\s+)?(?:talent (?:pool|community)(?:\s+(?:registration|application|posting|page))?|general application)(?:\s*[.,;:]|\s*$|\s+for\b)/i
const FUTURE_REGISTRATION = /^\s+(?:is|serves as)\s+(?:a|an)\s+(?:registration|expression of interest|general application)\s+for\s+future\s+(?:(?:software|backend|frontend|engineering|career|job|employment|technical)\s+){0,4}(?:opportunities|roles|openings|positions|vacancies)\b/i
const FUTURE_COLLECTION = /\b(?:collect(?:s|ing)?|accept(?:s|ing)?|gather(?:s|ing)?|shar(?:e|ing)|submit(?:ting)?|register(?:ing)?)\b.{0,80}\b(?:profiles?|resumes?|cvs?|applications?|interest)\b.{0,100}\b(?:for|to be considered for)\s+(?:potential\s+)?future\s+(?:opportunities|roles|openings|positions|vacancies)\b/i
const NO_OPENING = /\b(?:not (?:for )?(?:a|an|any)\s+(?:(?:currently\s+)?(?:current|specific|active|immediate|open)\s+)+(?:job\s+)?(?:opening|role|position|vacancy)|does not (?:represent|advertise)\s+(?:a|an)\s+(?:current|specific|active|open)\s+(?:job\s+)?(?:opening|role|position|vacancy))\b/i
const SOURCE_HEADING = /^(?:#{1,6}\s*)?(?:responsibilities|job description|about (?:this|the) role|the role|모집 내용|주요 업무)\s*[:：]?\s*\n/i
const ACTIVE_CURRENT_ROLE = /\b(?:we are|we're)\s+(?:(?:actively|currently|opportunistically)\s+)?(?:hiring|recruiting)\b[^.!?]{0,100}\b(?:for\s+)?this\s+(?:current\s+)?(?:role|position|opening|vacancy)\b|\bthis\s+(?:role|position|opening|vacancy)\s+(?:is|remains)\s+(?:currently\s+)?(?:open|available)\b|\bthis\s+(?:posting|post|expression of interest)\s+(?:advertises|describes|is for)\s+(?:a|an)\s+(?:current|active|open)\s+(?:role|position|opening|vacancy)\b/i
const KOREAN_ACTIVE_CURRENT_ROLE = /(?:현재|지금)\s*(?:이|본)\s*(?:포지션|직무|자리|공고)[^.!?]{0,60}(?:채용|모집)(?:을|를)?\s*(?:중(?:입니다|이며|이고)|(?:진행)?하고\s*있(?:습니다|어요|으며))/u

function registrationStatement(original: string, title: string): boolean {
  const text = original.replace(/[’‘]/g, "'").replace(/\s+/g, ' ').replace(/^[•*-]\s+/, '').trim()
  if (/^["“'‘>]/.test(text) || EXAMPLE.test(text)) return false
  if (POOL_DEFINITION.test(text)) return true
  const subject = SUBJECT.exec(text)
  if (subject) {
    if (FUTURE_REGISTRATION.test(text.slice(subject[0].length))) return true
    const collection = FUTURE_COLLECTION.exec(text)
    const prefix = collection ? text.slice(0, collection.index) : ''
    if (collection && !/\b(?:not|never|no longer|doesn't|don't|isn't|may|might|could|would|if|unless|when)\b/i.test(prefix)
      && !/\b(?:link|button|separate|another|other|also|instead|alternatively)\b/i.test(prefix)) return true
    if (REGISTRATION_TITLE.test(title) && NO_OPENING.test(text)) return true
  }
  if (REGISTRATION_TITLE.test(title) && /^this\s+is\s+not\s+(?:a|an)\s+(?:current|specific|active|immediate|open)\s+(?:job\s+)?(?:opening|role|position|vacancy)\b/i.test(text)) return true
  const koreanSubject = /^(?:이|본)\s*(?:채용\s*)?(?:공고|게시물|페이지|등록\s*페이지)(?:는|은|를|을|에서|로|를 통해)?/u.test(text)
  const negatedPool = /(?:인재\s*풀|인재\s*등록|관심\s*등록).{0,20}(?:아니|않|하지\s*않)/u.test(text)
  if (koreanSubject && !negatedPool
    && /(?:인재\s*풀\s*등록|채용\s*관심\s*등록)(?:을|를|에)?\s*(?:위한|목적|입니다|페이지)/u.test(text)) return true
  if (koreanSubject && !negatedPool
    && /현재.{0,40}(?:포지션|채용|공석|직무|자리).{0,15}(?:아닌|없)/u.test(text)
    && /향후.{0,60}(?:기회|포지션|직무).{0,20}(?:위한|위해).{0,20}(?:인재|관심|프로필)\s*등록/u.test(text)) return true
  return /(?:현재|지금).{0,40}(?:포지션|채용|공석|직무|자리).{0,20}(?:없|진행하지)/u.test(text)
    && /(?:이|본)\s*(?:등록|지원|채용)?\s*(?:페이지|공고|게시물)/u.test(text)
    && /이력서.{0,35}(?:제출|등록)/u.test(text)
    && /향후.{0,45}(?:기회|포지션|자리).{0,30}(?:생겼|생기|생길|발생).{0,30}연락/u.test(text)
    && !negatedPool
}

function purposeBlocks(description: string): string[] {
  const blocks: string[] = []
  let exampleHeading = false
  for (const paragraph of description.split(/\n\s*\n/)) {
    const block = paragraph.trim()
    const previousExample = exampleHeading
    exampleHeading = /^(?:examples?|sample (?:text|message|posting)|예시|예제)\s*[:：]?$/i.test(block)
    if (previousExample || exampleHeading || EXAMPLE.test(block)) continue
    const content = block.replace(SOURCE_HEADING, '').trim()
    if (content && !/^["“'‘>]/.test(content)) blocks.push(content)
  }
  return blocks
}

/** Positive evidence only. An EOI title or a footer invitation does not establish a pool. */
export function classifyPostingPurpose({ title, description, greenhouseProspect = false }: {
  title: string; description: string; greenhouseProspect?: boolean
}): JobPostingPurpose | undefined {
  if (greenhouseProspect === true) return {
    version: POSTING_PURPOSE_VERSION, kind: 'talent-pool', basis: 'greenhouse-prospect',
    evidence: [{ source: 'board', text: 'Greenhouse internal_job_id: null (prospect post)' }],
  }
  const blocks = purposeBlocks(description)
  // Conflicting descriptions remain unconfirmed; metadata above is authoritative.
  if (blocks.some(block => {
    const text = block.replace(/[’‘]/g, "'").replace(/\s+/g, ' ')
    return ACTIVE_CURRENT_ROLE.test(text) || KOREAN_ACTIVE_CURRENT_ROLE.test(text)
  })) return undefined
  const evidence: JobPostingPurpose['evidence'] = []
  for (const block of blocks) {
    let found = false
    for (const sentence of block.split(/(?<=[.!?])\s+(?=[A-Z가-힣])/u)) {
      const text = sentence.trim()
      if (text.length <= 3000 && registrationStatement(text, title)
        && !evidence.some(item => item.text === text)) {
        evidence.push({ source: 'description', text })
        found = true
      }
      if (evidence.length === 4) break
    }
    // A Korean no-opening statement and its future-contact purpose can span sentences.
    if (!found && block.length <= 3000 && registrationStatement(block, title)
      && !evidence.some(item => item.text === block)) evidence.push({ source: 'description', text: block })
    if (evidence.length === 4) break
  }
  return evidence.length ? { version: POSTING_PURPOSE_VERSION, kind: 'talent-pool', basis: 'description', evidence } : undefined
}

export function isTalentPoolJob(job: Job): boolean {
  const purpose = job.postingPurpose
  return job.source !== 'sample' && purpose?.version === POSTING_PURPOSE_VERSION && purpose.kind === 'talent-pool'
    && (purpose.basis === 'description' || purpose.basis === 'greenhouse-prospect' && job.source === 'greenhouse')
    && Array.isArray(purpose.evidence) && purpose.evidence.length >= 1 && purpose.evidence.length <= 4
    && purpose.evidence.every(item => item && typeof item.text === 'string'
      && item.text.trim().length > 0 && item.text.length <= 3000
      && item.source === (purpose.basis === 'description' ? 'description' : 'board'))
}

export function upgradeJobPostingPurpose<T extends Job>(job: T): T {
  if (job.source === 'sample') return job
  if (job.postingPurpose?.version === POSTING_PURPOSE_VERSION && isTalentPoolJob(job)) return job
  const purpose = classifyPostingPurpose({ title: job.title, description: job.description })
  if (purpose) return { ...job, postingPurpose: purpose }
  if (!job.postingPurpose) return job
  const { postingPurpose: _ignored, ...rest } = job
  return rest as T
}
