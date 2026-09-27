import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoardFetchError } from '../../server/catalog-service'
import { flightObjects, flightText, readNextFlight } from '../../server/providers/next-flight'
import { flightHtml, flightObjectHtml } from '../fixtures/careers-wire'

afterEach(() => vi.unstubAllGlobals())

describe('public Next Flight JSON and exact UTF-8 text records', () => {
  it('joins serialization chunks and reads a literal 17-byte multilingual body without evaluating JavaScript', () => {
    const records = readNextFlight(flightHtml('1:{"Job_Description":', '"$a","title":"Synthetic Design64"}\na:T11,café 🌏\n한글'))
    expect(flightObjects(records, 'Job_Description')).toEqual([{ Job_Description: '$a', title: 'Synthetic Design64' }])
    expect(flightText(records, '$a')).toBe('café 🌏\n한글')
    expect(flightText(records, 'Literal synthetic text64')).toBe('Literal synthetic text64')
  })

  it('reads nested JSON only and ignores resource/module/diagnostic records', () => {
    const records = readNextFlight(flightHtml(
      '0:I["module","file.js"]\n:HL["resource.css"]\n2:D{"timing":1}\n',
      '3:{"children":[{"Job_Description":"Synthetic body64","total":1}]}\n',
    ))
    expect(flightObjects(records, 'Job_Description')).toEqual([{ Job_Description: 'Synthetic body64', total: 1 }])
  })

  it.each([
    'a:T10,café 🌏\n한글', // One byte short, cuts a Hangul character.
    'a:T12,café 🌏\n한글', // One byte longer than the available payload.
    'a:Tf,too short',
    'a:Tzz,invalid length',
    'a:T-1,invalid length',
    'a:"first"\na:"second"\n',
    'a:T1,xa:"duplicate"\n',
    'nothex:{"Job_Description":"wrong record id"}\n',
    '1:{"Job_Description":invalid}\n',
  ])('rejects malformed record framing: %s', payload => {
    expect(() => readNextFlight(flightHtml(payload))).toThrow(BoardFetchError)
  })

  it.each(['$missing', '$a', '$L1', '$1:tail', '$'])('rejects unresolved or non-text references %s', reference => {
    expect(() => flightText(new Map([['1', { title: 'not text' }]]), reference)).toThrow(BoardFetchError)
  })

  it('does not follow chained or cyclic text references', () => {
    expect(() => flightText(new Map([['a', '$b'], ['b', '$a']]), '$a')).toThrow(BoardFetchError)
  })

  it('never executes a push expression, even when it resembles a job payload', () => {
    vi.stubGlobal('__stage64FlightExecuted', false)
    const html = '<script>self.__next_f.push((globalThis.__stage64FlightExecuted = true, [1,"1:{}\\n"]))</script>'
    expect(() => readNextFlight(html)).toThrow(BoardFetchError)
    expect(Reflect.get(globalThis, '__stage64FlightExecuted')).toBe(false)
  })

  it('rejects non-string/oversized HTML and missing data chunks', () => {
    for (const value of [{}, '<html>No Flight data</html>', 'x'.repeat(8 * 1024 * 1024 + 1)]) {
      expect(() => readNextFlight(value)).toThrow(BoardFetchError)
    }
  })

  it('bounds deeply nested data and record counts', () => {
    let nested: unknown = { Job_Description: 'Synthetic nested body64' }
    for (let index = 0; index < 62; index++) nested = { children: nested }
    expect(() => flightObjects(readNextFlight(flightObjectHtml(nested)), 'Job_Description')).toThrow(BoardFetchError)
    const tooMany = Array.from({ length: 10_001 }, (_, index) => `${index.toString(16)}:null\n`).join('')
    expect(() => readNextFlight(flightHtml(tooMany))).toThrow(BoardFetchError)
  })
})
