import { appendFileSync, readFileSync } from 'node:fs'

// Only an owned application child loads this transport. The real loader,
// provider parsers, catalog/cache, API and browser remain in the execution path.
const responsesFile = process.env.ORBIT_JOB_POSTING_RESPONSES_FILE
const requestLog = process.env.ORBIT_JOB_POSTING_REQUEST_LOG
if (!responsesFile || !requestLog) throw new Error('The job-posting transport needs isolated response and log files')

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
