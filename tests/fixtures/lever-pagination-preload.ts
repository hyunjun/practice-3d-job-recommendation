import { appendFileSync, readFileSync } from 'node:fs'

// Loaded only by an owned test child. No app API/state is replaced. Native
// timers still run; only its wall-clock boundary and upstream HTTP are inputs.
const responsesFile = process.env.ORBIT_LEVER_PAGINATION_RESPONSES
const requestLog = process.env.ORBIT_LEVER_PAGINATION_REQUEST_LOG
const clockFile = process.env.ORBIT_LEVER_PAGINATION_CLOCK
if (!responsesFile || !requestLog || !clockFile) throw new Error('Isolated Lever fixture paths are required')
Date.now = () => {
  const value = Date.parse(readFileSync(clockFile, 'utf8').trim())
  if (!Number.isFinite(value)) throw new Error('Invalid fixture clock')
  return value
}

globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  try {
    const responses = JSON.parse(readFileSync(responsesFile, 'utf8')) as Record<string, unknown>
    if (method !== 'GET' || !Object.hasOwn(responses, url)) throw new Error(`Unexpected upstream request: ${method} ${url}`)
    appendFileSync(requestLog, `${JSON.stringify({ url, method, at: new Date(Date.now()).toISOString(), synthetic: true, networkSent: false })}\n`)
    return Response.json(responses[url])
  } catch (error) {
    appendFileSync(requestLog, `${JSON.stringify({ url, method, synthetic: false, networkSent: false, error: String(error) })}\n`)
    throw error
  }
}
