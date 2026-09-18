import { CITIES, CITY_BY_ID } from './cities'
import { COMPANIES } from './companies'
import type { Catalog, Job, Role, Salary, Visa, WorkMode } from './types'

// Hand-authored demonstration scenarios, not a representation of real vacancies.
// Every demo job points to the company's careers page, never to an invented application.
const SCENARIOS: [string, string[]][] = [
  ['stripe', ['san-francisco', 'new-york', 'london', 'dublin', 'singapore']],
  ['figma', ['san-francisco', 'new-york', 'london', 'berlin', 'tokyo']],
  ['notion', ['san-francisco', 'new-york', 'london', 'dublin', 'seoul']],
  ['linear', ['san-francisco', 'new-york', 'london']],
  ['vercel', ['san-francisco', 'new-york', 'berlin', 'london']],
  ['cloudflare', ['san-francisco', 'austin', 'london', 'lisbon', 'singapore']],
  ['datadog', ['new-york', 'boston', 'paris', 'london', 'amsterdam']],
  ['mongodb', ['new-york', 'dublin', 'london', 'sydney', 'bengaluru']],
  ['spotify', ['stockholm', 'london', 'new-york', 'berlin']],
  ['airbnb', ['san-francisco', 'seattle', 'berlin', 'paris']],
  ['gitlab', ['amsterdam', 'berlin']],
  ['elastic', ['amsterdam', 'barcelona', 'zurich']],
  ['wise', ['london', 'singapore', 'austin']],
  ['revolut', ['london', 'berlin', 'lisbon', 'barcelona']],
  ['adyen', ['amsterdam', 'san-francisco', 'berlin']],
  ['shopify', ['toronto', 'vancouver', 'berlin']],
  ['canva', ['sydney', 'melbourne', 'london']],
  ['atlassian', ['sydney', 'bengaluru', 'seattle', 'amsterdam']],
  ['miro', ['amsterdam', 'berlin', 'london']],
  ['n26', ['berlin', 'barcelona']],
  ['zalando', ['berlin', 'dublin', 'zurich']],
  ['delivery-hero', ['berlin', 'singapore', 'seoul']],
  ['deepl', ['berlin', 'london', 'tokyo']],
  ['hugging-face', ['paris', 'new-york']],
  ['anthropic', ['san-francisco', 'london', 'new-york']],
  ['toss', ['seoul']],
  ['karrot', ['seoul', 'toronto']],
  ['smartnews', ['tokyo', 'san-francisco']],
  ['grab', ['singapore', 'bengaluru']],
  ['mercari', ['tokyo', 'bengaluru']],
  ['snyk', ['london', 'boston', 'zurich']],
  ['intercom', ['dublin', 'london', 'san-francisco']],
]

const ROLE_SCENARIOS: { role: Exclude<Role, 'all'>; title: string; skills: string[]; years: number; description: string }[] = [
  { role: 'backend', title: 'Senior Software Engineer, Backend', skills: ['Python', 'PostgreSQL', 'AWS', 'Docker'], years: 4, description: '안정적이고 확장 가능한 백엔드 서비스를 설계합니다. 제품 팀과 함께 API와 데이터 모델을 개선하고, 서비스 운영의 품질을 높이는 역할입니다.' },
  { role: 'frontend', title: 'Frontend Engineer, Product', skills: ['TypeScript', 'React', 'CSS', 'Next.js'], years: 3, description: '사람들이 매일 사용하는 제품의 경험을 만듭니다. 디자이너와 함께 빠르고 접근성 높은 인터페이스를 개발합니다.' },
  { role: 'fullstack', title: 'Software Engineer, Full Stack', skills: ['TypeScript', 'React', 'Node.js', 'PostgreSQL'], years: 3, description: '아이디어부터 출시까지 제품의 전 과정을 책임집니다. 사용자 인터페이스와 API를 함께 개발하며 팀의 피드백을 제품에 반영합니다.' },
  { role: 'devops', title: 'Senior Platform Engineer', skills: ['AWS', 'Kubernetes', 'Terraform', 'Python'], years: 5, description: '개발팀이 신뢰할 수 있는 클라우드 플랫폼을 구축합니다. 인프라 자동화와 관측 가능성을 개선하고 운영 부담을 줄입니다.' },
  { role: 'ml', title: 'Machine Learning Engineer', skills: ['Python', 'PyTorch', 'SQL', 'AWS'], years: 3, description: '머신러닝 모델을 실제 제품과 연결합니다. 모델 평가부터 배포, 추론 인프라까지 안정적인 ML 시스템을 만듭니다.' },
  { role: 'data', title: 'Data Engineer, Analytics Platform', skills: ['Python', 'SQL', 'Spark', 'PostgreSQL'], years: 3, description: '제품 의사결정의 기반이 되는 데이터 파이프라인을 구축합니다. 정확하고 활용하기 쉬운 데이터 환경을 만듭니다.' },
  { role: 'backend', title: 'Staff Engineer, Distributed Systems', skills: ['Go', 'Python', 'AWS', 'Kafka'], years: 8, description: '분산 시스템의 기술 방향을 이끕니다. 여러 팀과 함께 데이터 일관성, 서비스 확장성, 장기적인 아키텍처를 설계합니다.' },
  { role: 'mobile', title: 'Mobile Engineer', skills: ['React Native', 'TypeScript', 'Swift', 'Kotlin'], years: 3, description: '모바일에서 자연스럽게 작동하는 제품 경험을 개발합니다. 플랫폼의 특성을 이해하고 앱의 성능과 안정성을 개선합니다.' },
  { role: 'security', title: 'Application Security Engineer', skills: ['Python', 'AWS', 'Go', 'Docker'], years: 4, description: '개발 과정에 보안을 통합합니다. 위협 모델링과 코드 리뷰, 보안 자동화를 통해 팀이 안전한 제품을 만들도록 돕습니다.' },
]

const COUNTRY_SALARIES: Record<string, Salary> = {
  US: { min: 145000, max: 195000, currency: 'USD' },
  CA: { min: 130000, max: 175000, currency: 'CAD' },
  GB: { min: 85000, max: 120000, currency: 'GBP' },
  DE: { min: 80000, max: 110000, currency: 'EUR' },
  NL: { min: 85000, max: 115000, currency: 'EUR' },
  FR: { min: 75000, max: 100000, currency: 'EUR' },
  IE: { min: 90000, max: 125000, currency: 'EUR' },
  SE: { min: 78000, max: 108000, currency: 'EUR' },
  CH: { min: 115000, max: 155000, currency: 'CHF' },
  ES: { min: 65000, max: 90000, currency: 'EUR' },
  PT: { min: 55000, max: 80000, currency: 'EUR' },
  SG: { min: 130000, max: 180000, currency: 'SGD' },
  KR: { min: 85000000, max: 125000000, currency: 'KRW' },
  JP: { min: 9000000, max: 14000000, currency: 'JPY' },
  AU: { min: 145000, max: 195000, currency: 'AUD' },
  IN: { min: 55000, max: 85000, currency: 'USD' },
}

export function createSampleCatalog(): Catalog {
  const fetchedAt = '2026-09-18T00:00:00.000Z'
  const jobs: Job[] = []
  SCENARIOS.forEach(([companyId, cityIds], companyIndex) => {
    const company = COMPANIES.find(item => item.id === companyId)!
    cityIds.forEach((cityId, cityIndex) => {
      const city = CITY_BY_ID.get(cityId)!
      const variants = cityIndex < 2 ? 2 : 1
      for (let variant = 0; variant < variants; variant++) {
        const index = companyIndex * 3 + cityIndex + variant * 2
        const scenario = ROLE_SCENARIOS[index % ROLE_SCENARIOS.length]
        const base = COUNTRY_SALARIES[city.countryCode]
        const factor = scenario.years >= 8 ? 1.35 : 1 + ((companyIndex % 3) - 1) * 0.07
        const salary = index % 11 === 0 ? null : {
          min: Math.round(base.min * factor / 1000) * 1000,
          max: Math.round(base.max * factor / 1000) * 1000,
          currency: base.currency,
        }
        const visa: Visa = index % 5 < 2 ? 'yes' : index % 5 === 2 ? 'no' : 'unknown'
        const workMode: WorkMode = index % 4 === 0 ? 'onsite' : 'hybrid'
        jobs.push({
          id: `sample-${companyId}-${cityId}-${variant}`,
          companyId, title: scenario.title, role: scenario.role, cityIds: [cityId],
          locationLabel: `${city.en}, ${city.countryCode}`,
          workMode, employment: index % 17 === 0 ? 'contract' : 'fulltime',
          minExperience: scenario.years, skills: scenario.skills, salary, visa,
          remoteCountries: [], remoteWorldwide: false, remoteScopeUnknown: false,
          description: scenario.description,
          requirements: [
            `${scenario.years}년 이상의 관련 소프트웨어 개발 경험`,
            `${scenario.skills.slice(0, 3).join(', ')}를 활용한 제품 개발 경험`,
            '영어로 기술적 의견을 공유하고 여러 직군과 협업할 수 있는 능력',
          ],
          url: company.careerUrl, source: 'sample', updatedAt: null, fetchedAt,
        })
      }
    })
  })

  const remoteScenarios: [string, string[], boolean][] = [
    ['gitlab', [], true], ['vercel', ['US', 'CA', 'GB', 'DE', 'NL'], false],
    ['linear', [], true], ['elastic', ['US', 'CA', 'GB', 'DE', 'NL', 'FR', 'ES', 'KR'], false],
    ['shopify', ['CA', 'US', 'IE'], false], ['hugging-face', [], true],
    ['atlassian', ['US', 'CA', 'AU', 'IN', 'JP'], false],
    ['cloudflare', ['US', 'GB', 'DE', 'PT'], false],
    ['notion', ['US', 'CA'], false], ['canva', ['AU'], false],
    ['miro', ['NL', 'DE', 'GB', 'US'], false], ['datadog', ['US', 'CA', 'FR'], false],
  ]
  remoteScenarios.forEach(([companyId, countries, worldwide], index) => {
    const scenario = ROLE_SCENARIOS[index % ROLE_SCENARIOS.length]
    jobs.push({
      id: `sample-${companyId}-remote`,
      companyId, title: `${scenario.title} — Remote`, role: scenario.role, cityIds: [],
      locationLabel: worldwide ? 'Remote · Worldwide' : `Remote · ${countries.join(', ')}`,
      workMode: 'remote', employment: 'fulltime', minExperience: scenario.years,
      skills: scenario.skills, salary: { min: 100000 + index * 4000, max: 155000 + index * 4000, currency: 'USD' },
      visa: 'unknown', remoteCountries: countries, remoteWorldwide: worldwide, remoteScopeUnknown: false,
      description: scenario.description,
      requirements: [
        `${scenario.years}년 이상의 관련 개발 경험`,
        `${scenario.skills.slice(0, 3).join(', ')}를 활용한 실무 경험`,
        worldwide ? '분산 팀에서 비동기 커뮤니케이션으로 협업한 경험' : `거주 가능 국가: ${countries.join(', ')}. 시간대 중첩 조건은 회사에 확인이 필요합니다.`,
      ],
      url: COMPANIES.find(company => company.id === companyId)!.careerUrl,
      source: 'sample', updatedAt: null, fetchedAt,
    })
  })
  return { source: 'sample', fetchedAt, stale: false, companies: COMPANIES, cities: CITIES, jobs, boards: [], unmappedCount: 0 }
}
