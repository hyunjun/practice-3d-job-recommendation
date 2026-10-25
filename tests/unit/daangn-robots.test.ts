import { describe, expect, it } from 'vitest'
import { BoardFetchError } from '../../server/catalog-service'
import { parseRobotsPolicy, robotsAllows } from '../../server/providers/robots'

describe('official careers robots policy', () => {
  it('selects the longest matching product group, merges equally specific groups, and ignores wildcard restrictions', () => {
    const policy = parseRobotsPolicy([
      'User-agent: *', 'Disallow: /',
      'User-agent: Orbit', 'Disallow: /jobs/',
      'User-agent: ORBITCAREERATLAS', 'Allow: /jobs/', 'Disallow: /jobs/role/830001/',
      'User-agent: OrbitCareerAtlas', 'Allow: /jobs/role/830001/', 'Crawl-delay: 4',
      'User-agent: OtherCrawler', 'Disallow: /jobs/role/830101/', 'Crawl-delay: 59',
    ].join('\n'))
    expect(robotsAllows(policy, '/jobs/')).toBe(true)
    expect(robotsAllows(policy, '/jobs/role/830001/')).toBe(true) // Allow wins equal specificity.
    expect(robotsAllows(policy, '/jobs/role/830101/')).toBe(true)
    expect(policy.crawlDelayMs).toBe(4000)
  })

  it('supports consecutive agent lines and takes the largest delay from selected groups', () => {
    const policy = parseRobotsPolicy('User-agent: OtherCrawler\nUser-agent: OrbitCareerAtlas\nDisallow: /jobs/\nCrawl-delay: 3.5\n'
      + 'User-agent: OrbitCareerAtlas\nAllow: /jobs/role/\nCrawl-delay: 6\n')
    expect(robotsAllows(policy, '/jobs/')).toBe(false)
    expect(robotsAllows(policy, '/jobs/role/830001/')).toBe(true)
    expect(policy.crawlDelayMs).toBe(6000)
  })

  it.each([
    ['/jobs/', false], ['/jobs/role/830001/', false],
    ['/jobs/role/830101/', true], ['/jobs/role/830101/extra', false],
  ])('uses longest wildcard/end-anchor rules for %s', (path, allowed) => {
    const policy = parseRobotsPolicy('User-agent: *\nDisallow: /jobs/*\nAllow: /jobs/role/830101/$\n')
    expect(robotsAllows(policy, path)).toBe(allowed)
  })

  it.each([
    ['/%6Aobs/role/830001/', '/jobs/role/830001/', false],
    ['/jobs/role/%38%33%30%30%30%31/', '/jobs/role/830001/', false],
    ['/jobs/a%2fb', '/jobs/a%2Fb', false],
    ['/jobs/a%2Fb', '/jobs/a/b', true],
    ['/jobs/한글', '/jobs/%ED%95%9C%EA%B8%80', false],
    ['/jobs/role/830001/', '/Jobs/role/830001/', true],
  ])('compares encoded rule %s against %s without decoding reserved separators', (rule, path, allowed) => {
    expect(robotsAllows(parseRobotsPolicy(`User-agent: *\nDisallow: ${rule}\n`), path)).toBe(allowed)
  })

  it('allows an empty Disallow and ignores comments and sitemap records', () => {
    const policy = parseRobotsPolicy('\uFEFFUser-agent: *\r\nDisallow: # intentionally empty\r\nSitemap: https://example.invalid/map.xml\r\n')
    expect(robotsAllows(policy, '/jobs/')).toBe(true)
  })

  it.each(['', '# No restrictions\n', '\uFEFF# Comment-only robots\n',
    'Sitemap: https://example.invalid/map.xml\n', 'User-agent: *\nX-Fixture-Policy: public\nAllow: /jobs/\n',
  ])('preserves valid empty/comment-only and syntactically valid extension records', text => {
    expect(robotsAllows(parseRobotsPolicy(text), '/jobs/')).toBe(true)
  })

  it.each([
    'User-agent: *\nCrawl-delay: 60.001',
    'User-agent: *\nCrawl-delay: NaN',
    'User-agent: *\nCrawl-delay: -1',
    'User-agent: *\nDisallow: /jobs/%Q0',
    'User-agent: *\nDisallow: relative',
    '<html>blocked</html>',
    'User-agent: *\0\nAllow: /',
    'Disallow: /jobs/',
    '{"error":"unavailable"}',
    '\uFEFF# synthetic reverse-proxy error\n{"error":"unavailable"}\n',
    '# synthetic upstream error\n<html><body>Error: unavailable</body></html>',
    '\uFEFF# synthetic upstream error\nError message: unavailable',
    'User-agent: *\nInvalid field name: unavailable\n',
    '#'.repeat(512 * 1024 + 1),
  ])('fails closed for an invalid or unbounded policy', text => {
    expect(() => parseRobotsPolicy(text)).toThrow(BoardFetchError)
  })
})
