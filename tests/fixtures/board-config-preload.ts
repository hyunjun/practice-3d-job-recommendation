import { appendFileSync } from 'node:fs'
import { boardFixtureResponse } from './board-config'

// Loaded into an owned server/CLI child only, never into the browser or app.
// The log proves whether validation/cache hits contacted a provider. Even
// unexpected requests are recorded and blocked, with no real-network fallback.
const requestLog = process.env.ORBIT_BOARD_TEST_REQUEST_LOG
if (!requestLog) throw new Error('The board-config transport requires an isolated request log')

globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  try {
    if (method !== 'GET') throw new Error(`Unexpected fixture method: ${method}`)
    const json = boardFixtureResponse(url)
    appendFileSync(requestLog, `${JSON.stringify({ url, method, synthetic: true, networkSent: false })}\n`)
    return Response.json(json)
  } catch (error) {
    appendFileSync(requestLog, `${JSON.stringify({ url, method, synthetic: false, networkSent: false, error: String(error) })}\n`)
    throw error
  }
}
