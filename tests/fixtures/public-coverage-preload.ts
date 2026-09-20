import { appendFileSync, readFileSync } from 'node:fs'

// Loaded only by an owned fixture child. The real default loader, collectors,
// cache, HTTP API and browser run unchanged. There is no live-network fallback.
const responsesFile = process.env.ORBIT_PUBLIC_COVERAGE_RESPONSES
const requestLog = process.env.ORBIT_PUBLIC_COVERAGE_REQUEST_LOG
if (!responsesFile || !requestLog) throw new Error('Public coverage needs isolated response and log files')

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
