# 지역 대표 기업과 다른 산업의 SW 채용

2026-09-26 UTC에 **55개 회사**를 두 방향으로 조사했습니다. 앞선 조사에서 연결하지 못했던 회사의 재조사도 포함하므로 이전 조사 수에 단순 합산한 고유 회사 수는 아닙니다.

- 지역 대표 기업: 유럽, 아시아, 오세아니아, 중남미, 중동, 아프리카의 서비스·플랫폼·금융 기업.
- 다른 산업의 SW 채용: 외식, 가구 유통, 자동차, 여행, 언론, 물류 기업의 개발·컴퓨팅 직무.

공식 홈페이지, 공개 게시판의 회사 표시, 같은 게시 ID, 전체 목록과 본문을 대조해 **31개사**를 추가했습니다. 기본 수집 대상은 **124개사**이며 공식 출처 117곳과 Himalayas 원격 공고 표본 7곳으로 구성됩니다. Greenhouse 65개, Ashby 27개, Lever 9개, SmartRecruiters 10개, Workable 3개, 회사 공식 사이트 직접 수집 3개, Himalayas 7개입니다.

## 실제 반영 수량

새 회사에서 공개 ID **4,754개**, 개발·컴퓨팅 후보 **699개**를 반영했습니다. 직군 분류를 보완하면서 기존 93개사의 후보는 6,132개에서 6,050개로 바뀌었습니다. 합친 로컬 자료는 공개 ID **24,454개**, 후보 **6,749개**입니다.

후보는 자동 분류 결과이며 채용 인원이나 검증된 합격 가능성을 뜻하지 않습니다. 공개 ID에는 다른 직군이 포함되며, Starbucks의 ID 수는 공식 Technology 분류 안의 수량입니다. 각 회사는 지정한 게시판 하나를 수집하므로 모든 법인·브랜드·국가의 채용을 포괄하지 않습니다.

지도는 기존 22개 도시를 표시합니다. 그 밖의 도시 공고도 원문 근무지를 유지해 **기타 근무지**에서 검색·열람·저장할 수 있습니다. 제공하는 지역 탭에 속하지 않는 중동·아프리카 근무지는 **전 세계 → 기타 근무지**에서 찾을 수 있으며, 회사의 조사 지역을 실제 근무지로 대신 사용하지 않습니다.

기존 자료의 원문·링크·공개 ID·조회 시각·관측 방법 표시는 유지했습니다. 원본 캐시도 별도로 보관했습니다. 새 회사의 수집 시각은 22:47–23:14 UTC이며 기존 회사까지 같은 시각에 다시 수집한 자료가 아닙니다. 실제 자료와 상세 실행 기록은 공개 Git에 포함하지 않는 `.local/research/64-expansion/`에 있습니다.

## 지역 대표 기업 22곳

공개 ID 3,313개에서 개발·컴퓨팅 후보 505개를 반영했습니다. 지역은 조사 분류이며 개별 공고의 근무지·원격근무 조건과는 별개입니다.

| 조사 지역 | 공식 커리어 사이트 | 수집 게시판 | 공개 ID | 개발·컴퓨팅 후보 |
|---|---|---|---:|---:|
| 유럽 | [HelloFresh](https://careers.hellofresh.com/) | [Greenhouse · hellofresh](https://boards-api.greenhouse.io/v1/boards/hellofresh/jobs?content=true) | 444 | 45 |
| 유럽 | [Doctolib](https://careers.doctolib.com/) | [Greenhouse · doctolib](https://boards-api.greenhouse.io/v1/boards/doctolib/jobs?content=true) | 151 | 35 |
| 유럽 | [SumUp](https://www.sumup.com/careers/) | [Greenhouse · sumup](https://boards-api.greenhouse.io/v1/boards/sumup/jobs?content=true) | 359 | 36 |
| 유럽 | [BlaBlaCar](https://careers.blablacar.com/) | [Lever · blablacar](https://api.lever.co/v0/postings/blablacar?mode=json) | 14 | 4 |
| 아시아 | [Freshworks](https://www.freshworks.com/company/careers/) | [SmartRecruiters · Freshworks](https://api.smartrecruiters.com/v1/companies/Freshworks/postings) | 125 | 19 |
| 아시아 | [KRAFTON](https://www.krafton.com/en/careers/jobs/) | [Greenhouse · krafton](https://boards-api.greenhouse.io/v1/boards/krafton/jobs?content=true) | 63 | 17 |
| 오세아니아 | [Culture Amp](https://www.cultureamp.com/company/careers) | [Greenhouse · cultureamp](https://boards-api.greenhouse.io/v1/boards/cultureamp/jobs?content=true) | 45 | 10 |
| 오세아니아 | [Airwallex](https://www.airwallex.com/careers) | [Ashby · airwallex](https://api.ashbyhq.com/posting-api/job-board/airwallex) | 578 | 129 |
| 오세아니아 | [Immutable](https://www.immutable.com/careers) | [Lever · immutable](https://api.lever.co/v0/postings/immutable?mode=json) | 7 | 2 |
| 중남미 | [dLocal](https://www.dlocal.com/careers/) | [Lever · dlocal](https://api.lever.co/v0/postings/dlocal?mode=json) | 53 | 7 |
| 중남미 | [VTEX](https://careers.vtex.com/) | [Greenhouse · vtex](https://boards-api.greenhouse.io/v1/boards/vtex/jobs?content=true) | 27 | 7 |
| 중동 | [Careem](https://www.careem.com/en-AE/careers/) | [Greenhouse · careem](https://boards-api.greenhouse.io/v1/boards/careem/jobs?content=true) | 18 | 4 |
| 중동 | [Tamara](https://tamara.co/en-SA/careers) | [Greenhouse · tamara](https://boards-api.greenhouse.io/v1/boards/tamara/jobs?content=true) | 30 | 3 |
| 아프리카 | [Moniepoint](https://moniepoint.com/careers) | [Greenhouse · moniepoint](https://boards-api.greenhouse.io/v1/boards/moniepoint/jobs?content=true) | 161 | 8 |
| 유럽 | [Qonto](https://qonto.com/en/careers) | [Lever · qonto](https://api.lever.co/v0/postings/qonto?mode=json) | 38 | 8 |
| 유럽 | [Scalable Capital](https://de.scalable.capital/en/careers) | [SmartRecruiters · ScalableGmbH](https://api.smartrecruiters.com/v1/companies/ScalableGmbH/postings) | 111 | 40 |
| 아시아 | [Razorpay](https://razorpay.com/jobs/) | [Greenhouse · razorpaysoftwareprivatelimited](https://boards-api.greenhouse.io/v1/boards/razorpaysoftwareprivatelimited/jobs?content=true) | 26 | 1 |
| 중남미 | [Nubank](https://international.nubank.com.br/careers/) | [Ashby · nubank](https://api.ashbyhq.com/posting-api/job-board/nubank) | 117 | 54 |
| 유럽 | [Mollie](https://jobs.mollie.com/) | [Ashby · mollie](https://api.ashbyhq.com/posting-api/job-board/mollie) | 42 | 9 |
| 유럽 | [Booking.com / Booking Holdings](https://jobs.booking.com/booking/jobs) | [공식 사이트 · booking](https://jobs.booking.com/booking/jobs) | 144 | 34 |
| 유럽 | [Zalando](https://jobs.zalando.com/en/jobs) | [공식 사이트 · zalando](https://jobs.zalando.com/en/jobs) | 171 | 31 |
| 유럽 | [AUTO1 Group](https://www.auto1-group.com/en/jobs/) | [SmartRecruiters · Auto1](https://api.smartrecruiters.com/v1/companies/Auto1/postings) | 589 | 2 |

## 다른 산업의 SW 채용 기업 9곳

공개 ID 1,441개에서 개발·컴퓨팅 후보 194개를 반영했습니다. 지역은 조사 분류이며 개별 공고의 근무지·원격근무 조건과는 별개입니다.

| 조사 지역 | 공식 커리어 사이트 | 수집 게시판 | 공개 ID | 개발·컴퓨팅 후보 |
|---|---|---|---:|---:|
| 북미 | [McDonald’s](https://careers.mcdonalds.com/) | [SmartRecruiters · McDonaldsCorporation](https://api.smartrecruiters.com/v1/companies/McDonaldsCorporation/postings) | 4 | 2 |
| 유럽 | [IKEA (Inter IKEA Group)](https://www.ikea.com/global/en/our-business/work-with-us/) | [SmartRecruiters · InterIKEAGroup](https://api.smartrecruiters.com/v1/companies/InterIKEAGroup/postings) | 105 | 17 |
| 아시아 | [Woven by Toyota](https://woven.toyota/en/careers/) | [Lever · woven-by-toyota](https://api.lever.co/v0/postings/woven-by-toyota?mode=json) | 146 | 39 |
| 북미 | [Lucid Motors](https://lucidmotors.com/careers) | [Greenhouse · lucidmotors](https://boards-api.greenhouse.io/v1/boards/lucidmotors/jobs?content=true) | 432 | 28 |
| 아시아 | [Agoda](https://careersatagoda.com/) | [Greenhouse · agoda](https://boards-api.greenhouse.io/v1/boards/agoda/jobs?content=true) | 295 | 41 |
| 북미 | [The New York Times](https://www.nytco.com/careers/) | [Greenhouse · thenewyorktimes](https://boards-api.greenhouse.io/v1/boards/thenewyorktimes/jobs?content=true) | 145 | 12 |
| 북미 | [Flexport](https://www.flexport.com/careers/) | [Greenhouse · flexport](https://boards-api.greenhouse.io/v1/boards/flexport/jobs?content=true) | 199 | 25 |
| 유럽 | [Financial Times](https://aboutus.ft.com/careers/) | [Greenhouse · financialtimes33](https://boards-api.greenhouse.io/v1/boards/financialtimes33/jobs?content=true) | 57 | 8 |
| 북미 | [Starbucks](https://careers.starbucks.com/discover-opportunities/technology/) | [공식 사이트 · starbucks-technology](https://careers.starbucks.com/discover-opportunities/technology/) | 58 | 22 |

## 공식 사이트 직접 수집

| 출처 | 확인한 공개 경로 | 적용한 범위와 운영 정책 |
|---|---|---|
| [Zalando Jobs](https://jobs.zalando.com/en/jobs) · [robots.txt](https://jobs.zalando.com/robots.txt) | 15개씩 제공되는 공개 목록 페이지와 개별 공고 페이지. HTML에 포함된 JSON·텍스트 데이터를 읽음 | 전체 수·ID·페이지 순서, 목록과 본문의 ID·제목·회사·수정 시각 대조. 스크립트 실행이나 지원 양식 전송 없음. 시작 간격 1초, 동시 최대 2개 |
| [Booking.com Jobs](https://jobs.booking.com/booking/jobs) · [공개 API](https://jobs.booking.com/api/jobs?page=1&limit=100&sortBy=relevance&descending=false&internal=false) · [robots.txt](https://jobs.booking.com/robots.txt) | 100개씩 제공되는 공개 Jibe 목록 API. 응답에 본문과 추가 근무지 포함 | Booking.com과 Booking Holdings를 함께 표시. 내부 게시 제외, 게시판 식별자·전체 수·중복·회사·URL 경로 대조. robots의 5초 간격 적용, 동시 1개 |
| [Starbucks Technology](https://careers.starbucks.com/discover-opportunities/technology/) · [공개 채용 사이트](https://apply.starbucks.com/careers) · [robots.txt](https://apply.starbucks.com/robots.txt) | 공개 검색의 `filter_job_category=technology`, 10개씩 전체 페이지 조회. 본문은 공개 공고 페이지의 [JobPosting](https://schema.org/JobPosting) 구조화 데이터 | 적용된 Technology 필터·전체 수·ID 대조. 개별 페이지의 회사·제목·정규 공고 URL 확인. 시작 간격 10초, 동시 1개 |

Starbucks 상세 API는 최초 조사에서 본문을 확인했지만 반복 조회에 429를 반환했습니다. 간격을 늘린 시도도 실패해 기본 수집 경로로 채택하지 않았습니다. 최종 수집은 공개 목록 API 6회와 공개 공고 페이지 24회가 모두 정상 완료했습니다. 실제 페이지의 제목·본문·회사·고용 형태·근무지를 확인했으며 로그인·사내 채용·지원자 정보에는 접근하지 않았습니다.

세 출처의 목록과 본문은 **각각 정상 확인 후 24시간** 재사용합니다. 수동 새로고침에도 같은 간격이 적용되며, 실패에는 기존 지수 대기와 Retry-After를 따릅니다. 전체 회사 수집에는 최대 15분의 한도를 두고, 필요한 개발 직무 본문만 읽습니다. 일부 페이지 실패나 본문 불일치를 정상 빈 결과나 채용 마감으로 처리하지 않습니다.

Starbucks 공고가 Technology 목록에서 사라져도 분류 이동일 수 있습니다. 화면과 저장 기록에서 이 범위를 알리고 마감을 단정하지 않습니다. 구조화 데이터의 게시·SEO 만료 날짜를 본문 수정 시각이나 확정 마감 증거로 사용하지 않습니다.

## 보류한 회사

아래 회사도 조사 소스로 남깁니다. 등록하지 않았다는 사실은 해당 회사에 SW 채용이 없다는 뜻이 아닙니다.

| 조사한 공식 페이지 | 반영하지 않은 이유 |
|---|---|
| [Trade Republic](https://traderepublic.com/en-de/careers) | 기존 Greenhouse 목록 1건을 확인했으나 현재 직군 범위의 후보는 0건. 다른 채용 경로의 전체 범위는 미확정 |
| [Back Market](https://careers.backmarket.com/) | 공식 페이지 연결 시간 초과. 검토한 Lever 미국·EU 주소 모두 404 |
| [Personio](https://www.personio.com/careers/) | 공식 소개 페이지 429, 검토한 Ashby 주소 404 |
| [PhonePe](https://www.phonepe.com/careers/) | 공식 Job Openings 확인. 검토한 Greenhouse 주소는 404이며 현재 목록·본문 수집 규약은 미확정 |
| [BrowserStack](https://www.browserstack.com/careers) | 공식 페이지가 Workday로 연결. 현행 수집기가 지원하는 게시판과 다른 시스템 |
| [Postman](https://www.postman.com/company/careers/) | 공식 Open Positions 확인. 검토한 Greenhouse 주소는 404, 현재 전체 수집 경로는 미확정 |
| [Meesho](https://www.meesho.io/jobs) | 공식 채용 페이지 조사. 검토한 Greenhouse 주소 404 |
| [Xero](https://www.xero.com/careers/) | 공식 소개 페이지 403, 검토한 Lever 주소 404 |
| [SafetyCulture](https://safetyculture.com/careers) | 검토한 진입 URL이 Mitti 브랜드로 이동. SafetyCulture 본사의 현행 공고 연결을 확정하지 않음 |
| [Employment Hero](https://employmenthero.com/careers/) | 공식 채용 페이지 확인. 검토한 Workable 계정은 빈 목록이며 현행 전체 채용과의 연결 미확정 |
| [QuintoAndar](https://www.quintoandar.com.br/carreiras/) | 검토한 공식 경로 404, Workable 계정은 빈 목록. 현행 게시판 재확인 필요 |
| [Creditas](https://careers.creditas.com/) | 공식 경로가 이전 Greenhouse 페이지로 이동했으나 404 |
| [Rappi](https://about.rappi.com/join-us) | 공식 진입 페이지 조사. 검토한 Lever 주소 404 |
| [Tabby](https://tabby.ai/en-AE/careers) | 공식 채용 페이지 확인. 검토한 Greenhouse 주소 404, 현행 전체 수집 규약 미확정 |
| [Flutterwave](https://flutterwave.com/us/careers) | 공식 페이지 확인. Vacancies 경로 500, 검토한 Greenhouse 주소 404 |
| [Paystack](https://paystack.com/careers) | 공식 소개 페이지 403, 검토한 Greenhouse 주소 404 |
| [Yoco](https://www.yoco.com/careers/) | 공식 Open Roles 확인. 검토한 Greenhouse 주소 404, 현행 전체 수집 규약 미확정 |
| [Visa](https://corporate.visa.com/en/careers.html) | 공식 페이지가 Workday로 연결. 이전 SmartRecruiters 경로는 빈 목록 |
| [Bosch](https://www.bosch.com/careers/) | 공식 SmartRecruiters 4,805개 목록 확인. 전체 본문 수집이 기존 120초 한도를 초과해 부분 자료를 반영하지 않음 |
| [Toyota Connected](https://www.toyotaconnected.com/careers) | Greenhouse 공개 목록 1건 확인, 현재 개발·컴퓨팅 후보는 0건. Woven by Toyota는 별도 공식 게시판으로 추가 |
| [Rivian](https://careers.rivian.com/) | 공식 커리어 사이트 확인. 검토한 Greenhouse 주소 404, 현행 사이트 수집 규약 미확정 |
| [Skyscanner](https://www.skyscanner.net/jobs/) | 공식 Current Jobs 확인. 검토한 Greenhouse 주소 404, 현행 전체 수집 규약 미확정 |
| [GSK](https://www.gsk.com/en-gb/careers/) | 공식 커리어 사이트 확인. 검토한 SmartRecruiters 계정은 빈 목록이며 현행 시스템 연결 미확정 |
| [Walmart Technology](https://careers.walmart.com/us/en/home/careers-areas/technology) · [robots.txt](https://careers.walmart.com/robots.txt) | 공식 검색 API·검색 경로의 자동 수집 제한을 확인. 공개 sitemap만으로 SW 목록을 구분하지 못했고, Himalayas 대체 응답도 전체 1건·실제 배열 0건으로 불일치해 미반영 |

## 비IT 직군 혼입 보완

기존의 일반적인 Engineer·Developer 제목 판정만으로는 사업 개발, CAD, 공정, 자동차 내장재·배터리 시험·공급 품질 같은 공고가 SW 추천에 섞였습니다. 직군 해석을 6판으로 보완했습니다.

- 명시적인 Business Developer·Market Developer와 관리직 약어 Mgr·Dir를 구분합니다. 소프트웨어 직무의 제품 이름에 들어간 Market Developer Platform이나 Directory Services는 그대로 유지합니다.
- 직무 제목과 실제 게시 부서에 적힌 물리적 전문 분야를 확인합니다. 회사 이름이나 업종만으로 SW 직무를 제외하지 않습니다.
- Software·Firmware·Embedded·Web·Network·EDA·RTL·MES 등 명시적인 컴퓨팅 직무는 유지합니다. 가구·섬유의 Design Engineer와 소프트웨어 부서·실제 개발 업무를 확인한 Design Engineer를 구분합니다. 제품 이름에 들어간 Maintenance Systems를 설비 유지보수 직무로 해석하지 않습니다.
- 정보가 부족한 Design Engineer는 미확인으로 두되, 목록만 읽는 수집기는 본문을 읽은 후 판단합니다.

일반 직무명, 복합 직무, 다양한 언어의 자동 분류에는 한계가 있습니다. 원문과 판단 근거를 제공하고, 탐색에서 제외된 공개 직군도 사용자가 이미 저장한 원문·메모·지원 기록에서는 삭제하지 않습니다.

본문 캐시의 읽기·쓰기 한도는 128 MiB입니다. 초과 자료는 기존 정상 캐시를 덮어쓰기 전에 거부합니다. 현재 합친 캐시는 60,644,764바이트이며 실제 파일 읽기 경로로 다시 열어 확인했습니다.

이전 IT 기업·잡 사이트 조사는 [기존 출처 조사](source-survey.md), 수집과 저장 상태의 의미는 [게시 확인 정책](posting-presence.md), 독립 검증 결과는 [단계별 기록](improvements.md)에 이어집니다.
