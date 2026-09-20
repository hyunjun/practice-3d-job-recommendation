import { appendFileSync, readFileSync } from 'node:fs'

// Loaded only by an owned test child; preserve the actual loader, four-provider
// collector, normalizers, cache and API while prohibiting external ATS traffic.
const responsesFile = process.env.ORBIT_JOB_LANGUAGES_RESPONSES_FILE
const requestLog = process.env.ORBIT_JOB_LANGUAGES_REQUEST_LOG
if (!responsesFile || !requestLog) throw new Error('The language transport needs private response/log files')

globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  try {
    if (method !== 'GET') throw new Error(`Unexpected fixture method: ${method}`)
    const responses = JSON.parse(readFileSync(responsesFile, 'utf8')) as Record<string, unknown>
    if (!Object.hasOwn(responses, url)) throw new Error(`Unexpected upstream fixture URL: ${url}`)
    appendFileSync(requestLog, `${JSON.stringify({ url, method, synthetic: true, networkSent: false })}\n`)
    return Response.json(responses[url])
  } catch (error) {
    appendFileSync(requestLog, `${JSON.stringify({ url, method, synthetic: false, networkSent: false, error: String(error) })}\n`)
    throw error
  }
}
