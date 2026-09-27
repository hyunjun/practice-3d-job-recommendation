import type { Company } from '../../shared/types'

// Approved employer metadata only, frozen from the explicitly authorized
// Stage64 manifest SHA256 3bb15b9da55189049683c7bbab91e341fd8bcdfa83fe071519364bf31716b090.
// Expected URLs and identities are literal; no product registry builds them.
export const SOURCE_EXPANSION_REGISTRATIONS = [
  {
    "id": "hellofresh",
    "name": "HelloFresh",
    "provider": "greenhouse",
    "board": "hellofresh",
    "careerUrl": "https://careers.hellofresh.com/",
    "industry": "식품 · 밀키트",
    "cohort": "regional",
    "region": "Europe"
  },
  {
    "id": "doctolib",
    "name": "Doctolib",
    "provider": "greenhouse",
    "board": "doctolib",
    "careerUrl": "https://careers.doctolib.com/",
    "industry": "헬스케어 · 진료 플랫폼",
    "cohort": "regional",
    "region": "Europe"
  },
  {
    "id": "sumup",
    "name": "SumUp",
    "provider": "greenhouse",
    "board": "sumup",
    "careerUrl": "https://www.sumup.com/careers/",
    "industry": "핀테크 · 결제",
    "cohort": "regional",
    "region": "Europe"
  },
  {
    "id": "blablacar",
    "name": "BlaBlaCar",
    "provider": "lever",
    "board": "blablacar",
    "careerUrl": "https://careers.blablacar.com/",
    "industry": "모빌리티 · 카풀",
    "cohort": "regional",
    "region": "Europe"
  },
  {
    "id": "freshworks",
    "name": "Freshworks",
    "provider": "smartrecruiters",
    "board": "Freshworks",
    "careerUrl": "https://www.freshworks.com/company/careers/",
    "industry": "기업용 소프트웨어",
    "cohort": "regional",
    "region": "Asia"
  },
  {
    "id": "krafton",
    "name": "KRAFTON",
    "provider": "greenhouse",
    "board": "krafton",
    "careerUrl": "https://www.krafton.com/en/careers/jobs/",
    "industry": "게임 · 엔터테인먼트",
    "cohort": "regional",
    "region": "Asia"
  },
  {
    "id": "cultureamp",
    "name": "Culture Amp",
    "provider": "greenhouse",
    "board": "cultureamp",
    "careerUrl": "https://www.cultureamp.com/company/careers",
    "industry": "HR · 조직 분석",
    "cohort": "regional",
    "region": "Oceania"
  },
  {
    "id": "airwallex",
    "name": "Airwallex",
    "provider": "ashby",
    "board": "airwallex",
    "careerUrl": "https://www.airwallex.com/careers",
    "industry": "핀테크 · 글로벌 결제",
    "cohort": "regional",
    "region": "Oceania"
  },
  {
    "id": "immutable",
    "name": "Immutable",
    "provider": "lever",
    "board": "immutable",
    "careerUrl": "https://www.immutable.com/careers",
    "industry": "게임 · 디지털 자산",
    "cohort": "regional",
    "region": "Oceania"
  },
  {
    "id": "dlocal",
    "name": "dLocal",
    "provider": "lever",
    "board": "dlocal",
    "careerUrl": "https://www.dlocal.com/careers/",
    "industry": "핀테크 · 글로벌 결제",
    "cohort": "regional",
    "region": "Latin America"
  },
  {
    "id": "vtex",
    "name": "VTEX",
    "provider": "greenhouse",
    "board": "vtex",
    "careerUrl": "https://careers.vtex.com/",
    "industry": "커머스 · 소프트웨어",
    "cohort": "regional",
    "region": "Latin America"
  },
  {
    "id": "careem",
    "name": "Careem",
    "provider": "greenhouse",
    "board": "careem",
    "careerUrl": "https://www.careem.com/en-AE/careers/",
    "industry": "모빌리티 · 배달",
    "cohort": "regional",
    "region": "Middle East"
  },
  {
    "id": "tamara",
    "name": "Tamara",
    "provider": "greenhouse",
    "board": "tamara",
    "careerUrl": "https://tamara.co/en-SA/careers",
    "industry": "핀테크 · 결제",
    "cohort": "regional",
    "region": "Middle East"
  },
  {
    "id": "moniepoint",
    "name": "Moniepoint",
    "provider": "greenhouse",
    "board": "moniepoint",
    "careerUrl": "https://moniepoint.com/careers",
    "industry": "금융 · 기업 뱅킹",
    "cohort": "regional",
    "region": "Africa"
  },
  {
    "id": "mcdonalds",
    "name": "McDonald’s",
    "provider": "smartrecruiters",
    "board": "McDonaldsCorporation",
    "careerUrl": "https://careers.mcdonalds.com/",
    "industry": "외식 · 프랜차이즈",
    "cohort": "cross-industry",
    "region": "North America"
  },
  {
    "id": "ikea",
    "name": "IKEA (Inter IKEA Group)",
    "provider": "smartrecruiters",
    "board": "InterIKEAGroup",
    "careerUrl": "https://www.ikea.com/global/en/our-business/work-with-us/",
    "industry": "유통 · 가구",
    "cohort": "cross-industry",
    "region": "Europe"
  },
  {
    "id": "woven",
    "name": "Woven by Toyota",
    "provider": "lever",
    "board": "woven-by-toyota",
    "careerUrl": "https://woven.toyota/en/careers/",
    "industry": "자동차 · 모빌리티 소프트웨어",
    "cohort": "cross-industry",
    "region": "Asia"
  },
  {
    "id": "lucid",
    "name": "Lucid Motors",
    "provider": "greenhouse",
    "board": "lucidmotors",
    "careerUrl": "https://lucidmotors.com/careers",
    "industry": "자동차 · 전기차",
    "cohort": "cross-industry",
    "region": "North America"
  },
  {
    "id": "agoda",
    "name": "Agoda",
    "provider": "greenhouse",
    "board": "agoda",
    "careerUrl": "https://careersatagoda.com/",
    "industry": "여행 · 숙박",
    "cohort": "cross-industry",
    "region": "Asia"
  },
  {
    "id": "newyorktimes",
    "name": "The New York Times",
    "provider": "greenhouse",
    "board": "thenewyorktimes",
    "careerUrl": "https://www.nytco.com/careers/",
    "industry": "언론 · 미디어",
    "cohort": "cross-industry",
    "region": "North America"
  },
  {
    "id": "flexport",
    "name": "Flexport",
    "provider": "greenhouse",
    "board": "flexport",
    "careerUrl": "https://www.flexport.com/careers/",
    "industry": "물류 · 공급망",
    "cohort": "cross-industry",
    "region": "North America"
  },
  {
    "id": "qonto",
    "name": "Qonto",
    "provider": "lever",
    "board": "qonto",
    "careerUrl": "https://qonto.com/en/careers",
    "industry": "금융 · 기업 뱅킹",
    "cohort": "regional",
    "region": "Europe"
  },
  {
    "id": "scalablecapital",
    "name": "Scalable Capital",
    "provider": "smartrecruiters",
    "board": "ScalableGmbH",
    "careerUrl": "https://de.scalable.capital/en/careers",
    "industry": "금융 · 투자",
    "cohort": "regional",
    "region": "Europe"
  },
  {
    "id": "razorpay",
    "name": "Razorpay",
    "provider": "greenhouse",
    "board": "razorpaysoftwareprivatelimited",
    "careerUrl": "https://razorpay.com/jobs/",
    "industry": "핀테크 · 결제",
    "cohort": "regional",
    "region": "Asia"
  },
  {
    "id": "nubank",
    "name": "Nubank",
    "provider": "ashby",
    "board": "nubank",
    "careerUrl": "https://international.nubank.com.br/careers/",
    "industry": "금융 · 디지털 뱅킹",
    "cohort": "regional",
    "region": "Latin America"
  },
  {
    "id": "financialtimes",
    "name": "Financial Times",
    "provider": "greenhouse",
    "board": "financialtimes33",
    "careerUrl": "https://aboutus.ft.com/careers/",
    "industry": "언론 · 금융 미디어",
    "cohort": "cross-industry",
    "region": "Europe"
  },
  {
    "id": "mollie",
    "name": "Mollie",
    "provider": "ashby",
    "board": "mollie",
    "careerUrl": "https://jobs.mollie.com/",
    "industry": "핀테크 · 결제",
    "cohort": "regional",
    "region": "Europe"
  },
  {
    "id": "booking",
    "name": "Booking.com / Booking Holdings",
    "provider": "careers",
    "board": "booking",
    "careerUrl": "https://jobs.booking.com/booking/jobs",
    "industry": "여행 · 숙박",
    "cohort": "regional",
    "region": "Europe"
  },
  {
    "id": "zalando",
    "name": "Zalando",
    "provider": "careers",
    "board": "zalando",
    "careerUrl": "https://jobs.zalando.com/en/jobs",
    "industry": "커머스 · 패션",
    "cohort": "regional",
    "region": "Europe"
  },
  {
    "id": "starbucks",
    "name": "Starbucks",
    "provider": "careers",
    "board": "starbucks-technology",
    "careerUrl": "https://careers.starbucks.com/discover-opportunities/technology/",
    "industry": "외식 · 커피",
    "cohort": "cross-industry",
    "region": "North America"
  },
  {
    "id": "auto1",
    "name": "AUTO1 Group",
    "provider": "smartrecruiters",
    "board": "Auto1",
    "careerUrl": "https://www.auto1-group.com/en/jobs/",
    "industry": "자동차 · 커머스",
    "cohort": "regional",
    "region": "Europe"
  }
] satisfies (Pick<Company, 'id' | 'name' | 'provider' | 'board' | 'careerUrl' | 'industry'> & { cohort: string; region: string })[]

export const SOURCE_EXPANSION_IDS = [
  "hellofresh",
  "doctolib",
  "sumup",
  "blablacar",
  "freshworks",
  "krafton",
  "cultureamp",
  "airwallex",
  "immutable",
  "dlocal",
  "vtex",
  "careem",
  "tamara",
  "moniepoint",
  "mcdonalds",
  "ikea",
  "woven",
  "lucid",
  "agoda",
  "newyorktimes",
  "flexport",
  "qonto",
  "scalablecapital",
  "razorpay",
  "nubank",
  "financialtimes",
  "mollie",
  "booking",
  "zalando",
  "starbucks",
  "auto1"
] as const

export const SOURCE_EXPANSION_ATS_FULL_URLS: Record<string, string> = {
  "hellofresh": "https://boards-api.greenhouse.io/v1/boards/hellofresh/jobs?content=true&pay_transparency=true",
  "doctolib": "https://boards-api.greenhouse.io/v1/boards/doctolib/jobs?content=true&pay_transparency=true",
  "sumup": "https://boards-api.greenhouse.io/v1/boards/sumup/jobs?content=true&pay_transparency=true",
  "blablacar": "https://api.lever.co/v0/postings/blablacar?mode=json&limit=50&skip=0",
  "freshworks": "https://api.smartrecruiters.com/v1/companies/Freshworks/postings?limit=100&offset=0&destination=PUBLIC",
  "krafton": "https://boards-api.greenhouse.io/v1/boards/krafton/jobs?content=true&pay_transparency=true",
  "cultureamp": "https://boards-api.greenhouse.io/v1/boards/cultureamp/jobs?content=true&pay_transparency=true",
  "airwallex": "https://api.ashbyhq.com/posting-api/job-board/airwallex?includeCompensation=true",
  "immutable": "https://api.lever.co/v0/postings/immutable?mode=json&limit=50&skip=0",
  "dlocal": "https://api.lever.co/v0/postings/dlocal?mode=json&limit=50&skip=0",
  "vtex": "https://boards-api.greenhouse.io/v1/boards/vtex/jobs?content=true&pay_transparency=true",
  "careem": "https://boards-api.greenhouse.io/v1/boards/careem/jobs?content=true&pay_transparency=true",
  "tamara": "https://boards-api.greenhouse.io/v1/boards/tamara/jobs?content=true&pay_transparency=true",
  "moniepoint": "https://boards-api.greenhouse.io/v1/boards/moniepoint/jobs?content=true&pay_transparency=true",
  "mcdonalds": "https://api.smartrecruiters.com/v1/companies/McDonaldsCorporation/postings?limit=100&offset=0&destination=PUBLIC",
  "ikea": "https://api.smartrecruiters.com/v1/companies/InterIKEAGroup/postings?limit=100&offset=0&destination=PUBLIC",
  "woven": "https://api.lever.co/v0/postings/woven-by-toyota?mode=json&limit=50&skip=0",
  "lucid": "https://boards-api.greenhouse.io/v1/boards/lucidmotors/jobs?content=true&pay_transparency=true",
  "agoda": "https://boards-api.greenhouse.io/v1/boards/agoda/jobs?content=true&pay_transparency=true",
  "newyorktimes": "https://boards-api.greenhouse.io/v1/boards/thenewyorktimes/jobs?content=true&pay_transparency=true",
  "flexport": "https://boards-api.greenhouse.io/v1/boards/flexport/jobs?content=true&pay_transparency=true",
  "qonto": "https://api.lever.co/v0/postings/qonto?mode=json&limit=50&skip=0",
  "scalablecapital": "https://api.smartrecruiters.com/v1/companies/ScalableGmbH/postings?limit=100&offset=0&destination=PUBLIC",
  "razorpay": "https://boards-api.greenhouse.io/v1/boards/razorpaysoftwareprivatelimited/jobs?content=true&pay_transparency=true",
  "nubank": "https://api.ashbyhq.com/posting-api/job-board/nubank?includeCompensation=true",
  "financialtimes": "https://boards-api.greenhouse.io/v1/boards/financialtimes33/jobs?content=true&pay_transparency=true",
  "mollie": "https://api.ashbyhq.com/posting-api/job-board/mollie?includeCompensation=true",
  "auto1": "https://api.smartrecruiters.com/v1/companies/Auto1/postings?limit=100&offset=0&destination=PUBLIC"
}

export const SOURCE_EXPANSION_ATS_PRESENCE_URLS: Record<string, string> = {
  "hellofresh": "https://boards-api.greenhouse.io/v1/boards/hellofresh/jobs?content=false",
  "doctolib": "https://boards-api.greenhouse.io/v1/boards/doctolib/jobs?content=false",
  "sumup": "https://boards-api.greenhouse.io/v1/boards/sumup/jobs?content=false",
  "blablacar": "https://api.lever.co/v0/postings/blablacar?mode=json&limit=50&skip=0",
  "freshworks": "https://api.smartrecruiters.com/v1/companies/Freshworks/postings?limit=100&offset=0&destination=PUBLIC",
  "krafton": "https://boards-api.greenhouse.io/v1/boards/krafton/jobs?content=false",
  "cultureamp": "https://boards-api.greenhouse.io/v1/boards/cultureamp/jobs?content=false",
  "airwallex": "https://api.ashbyhq.com/posting-api/job-board/airwallex",
  "immutable": "https://api.lever.co/v0/postings/immutable?mode=json&limit=50&skip=0",
  "dlocal": "https://api.lever.co/v0/postings/dlocal?mode=json&limit=50&skip=0",
  "vtex": "https://boards-api.greenhouse.io/v1/boards/vtex/jobs?content=false",
  "careem": "https://boards-api.greenhouse.io/v1/boards/careem/jobs?content=false",
  "tamara": "https://boards-api.greenhouse.io/v1/boards/tamara/jobs?content=false",
  "moniepoint": "https://boards-api.greenhouse.io/v1/boards/moniepoint/jobs?content=false",
  "mcdonalds": "https://api.smartrecruiters.com/v1/companies/McDonaldsCorporation/postings?limit=100&offset=0&destination=PUBLIC",
  "ikea": "https://api.smartrecruiters.com/v1/companies/InterIKEAGroup/postings?limit=100&offset=0&destination=PUBLIC",
  "woven": "https://api.lever.co/v0/postings/woven-by-toyota?mode=json&limit=50&skip=0",
  "lucid": "https://boards-api.greenhouse.io/v1/boards/lucidmotors/jobs?content=false",
  "agoda": "https://boards-api.greenhouse.io/v1/boards/agoda/jobs?content=false",
  "newyorktimes": "https://boards-api.greenhouse.io/v1/boards/thenewyorktimes/jobs?content=false",
  "flexport": "https://boards-api.greenhouse.io/v1/boards/flexport/jobs?content=false",
  "qonto": "https://api.lever.co/v0/postings/qonto?mode=json&limit=50&skip=0",
  "scalablecapital": "https://api.smartrecruiters.com/v1/companies/ScalableGmbH/postings?limit=100&offset=0&destination=PUBLIC",
  "razorpay": "https://boards-api.greenhouse.io/v1/boards/razorpaysoftwareprivatelimited/jobs?content=false",
  "nubank": "https://api.ashbyhq.com/posting-api/job-board/nubank",
  "financialtimes": "https://boards-api.greenhouse.io/v1/boards/financialtimes33/jobs?content=false",
  "mollie": "https://api.ashbyhq.com/posting-api/job-board/mollie",
  "auto1": "https://api.smartrecruiters.com/v1/companies/Auto1/postings?limit=100&offset=0&destination=PUBLIC"
}

export const SOURCE_EXPANSION_PROVIDER_COUNTS = { greenhouse: 65, ashby: 27, lever: 9, smartrecruiters: 10, workable: 3, himalayas: 7, careers: 3 } as const
