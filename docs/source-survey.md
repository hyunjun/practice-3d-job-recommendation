# 공개 채용 출처 조사와 확장

2026-09-26 UTC에 기존 공개 목록의 36개 회사와 별도로 **기업 후보 107곳과 공개 잡 사이트 12곳**을 조사했습니다. 빅테크, 기업용 소프트웨어, 반도체, AI, 개발자 도구, 데이터·클라우드, 핀테크, 게임, 아시아 주요 IT 회사와 기존 샘플에 있던 회사를 포함한 선정 목록입니다.

공식 게시판 47곳을 추가한 뒤 Workable 공식 게시판 3곳과 Himalayas의 공개 원격 공고 7곳을 더 연결했습니다. 현재 기본 수집 대상은 **93개사: 공식 게시판 86곳과 공개 잡 사이트 표본 7곳**입니다. Greenhouse 50개, Ashby 24개, Lever 4개, SmartRecruiters 5개, Workable 3개, Himalayas 7개입니다. 샘플의 32개 회사·179개 공고·22개 도시는 별도로 유지합니다.

## 추가 기준과 해석

- 공식 커리어 페이지의 연결, 같은 게시 ID, 제공자가 운영하는 게시판의 회사 표시를 대조합니다. 이름으로 추측한 주소가 응답한다는 사실만으로 등록하지 않습니다.
- 실제 수집기로 전체 ID·본문·제공자·회사·필수 URL·페이지의 완전성을 검증한 결과를 반영합니다. 실패하거나 빈 응답인 후보는 회사 전체의 채용 0건으로 표현하지 않습니다.
- 회사마다 한 게시판을 등록합니다. 해당 기업의 모든 법인·브랜드·별도 채용 시스템을 포괄하는 목록은 아닙니다. 채용 인원이 아닌 게시 ID를 세며 다른 기업 게시판 사이의 동일 포지션까지 판별하지 않습니다.
- 개발·컴퓨팅 수는 현재 자동 직군 분류의 **후보**입니다. 원문 의미·언어·직무 경계에 따른 오분류 가능성이 있으며 모든 항목을 사람이 판정한 수치는 아닙니다.
- 실제 응답·본문·URL·조회 시각과 상세 증거는 Git에서 제외되는 로컬 자료에 보존합니다. 공개 회귀 검사에는 직접 작성한 가상 공고를 사용합니다.

공식 소개 페이지의 접근 상태와 공개 게시판의 접근 상태는 다를 수 있습니다. 일부 소개 페이지는 403 또는 429를 반환했지만 제공자의 공개 API와 게시판 회사 표시를 확인할 수 있었습니다. 해당 소개 페이지에 대한 접근 제한을 우회하거나 같은 요청을 반복한 결과로 보고하지 않습니다.

## 61단계에서 추가한 공식 게시판 47곳

아래 수치는 각 게시판을 실제 조회한 **2026-09-26 UTC**의 기록입니다. 전체 공개 ID에는 모든 직군이 포함되고, 후보에는 개발·컴퓨팅 분류와 인재풀이 포함될 수 있습니다. 일상 조회 후 수치는 달라집니다.

| 회사의 공식 커리어 사이트 | 수집 API · 게시판 | 전체 공개 ID | 개발·컴퓨팅 후보 |
|---|---|---:|---:|
| [Adyen](https://careers.adyen.com/) | [Greenhouse · adyen](https://boards-api.greenhouse.io/v1/boards/adyen/jobs?content=true) | 210 | 44 |
| [Affirm](https://www.affirm.com/careers) | [Greenhouse · affirm](https://boards-api.greenhouse.io/v1/boards/affirm/jobs?content=true) | 180 | 100 |
| [Automattic](https://automattic.com/work-with-us/) | [Greenhouse · automatticcareers](https://boards-api.greenhouse.io/v1/boards/automatticcareers/jobs?content=true) | 16 | 2 |
| [Brave](https://brave.com/careers/) | [Greenhouse · brave](https://boards-api.greenhouse.io/v1/boards/brave/jobs?content=true) | 13 | 4 |
| [Brex](https://www.brex.com/careers) | [Greenhouse · brex](https://boards-api.greenhouse.io/v1/boards/brex/jobs?content=true) | 259 | 48 |
| [Canonical](https://canonical.com/careers) | [Greenhouse · canonical](https://boards-api.greenhouse.io/v1/boards/canonical/jobs?content=true) | 306 | 94 |
| [ClickHouse](https://clickhouse.com/company/careers) | [Ashby · ClickHouse](https://api.ashbyhq.com/posting-api/job-board/ClickHouse) | 189 | 108 |
| [Cockroach Labs](https://www.cockroachlabs.com/careers/) | [Greenhouse · cockroachlabs](https://boards-api.greenhouse.io/v1/boards/cockroachlabs/jobs?content=true) | 19 | 1 |
| [Cohere](https://cohere.com/careers) | [Ashby · cohere](https://api.ashbyhq.com/posting-api/job-board/cohere) | 147 | 45 |
| [Confluent](https://careers.confluent.io/) | [Ashby · confluent](https://api.ashbyhq.com/posting-api/job-board/confluent) | 20 | 11 |
| [Coupang](https://www.coupang.jobs/en/) | [Greenhouse · coupang](https://boards-api.greenhouse.io/v1/boards/coupang/jobs?content=true) | 708 | 156 |
| [Cursor](https://www.cursor.com/careers) | [Ashby · cursor](https://api.ashbyhq.com/posting-api/job-board/cursor) | 126 | 36 |
| [Delivery Hero](https://careers.deliveryhero.com/) | [SmartRecruiters · DeliveryHero](https://api.smartrecruiters.com/v1/companies/DeliveryHero/postings) | 962 | 42 |
| [DigitalOcean](https://www.digitalocean.com/careers) | [Greenhouse · digitalocean98](https://boards-api.greenhouse.io/v1/boards/digitalocean98/jobs?content=true) | 164 | 90 |
| [Docker](https://www.docker.com/careers/) | [Ashby · docker](https://api.ashbyhq.com/posting-api/job-board/docker) | 58 | 21 |
| [Elastic](https://www.elastic.co/careers) | [Greenhouse · elastic](https://boards-api.greenhouse.io/v1/boards/elastic/jobs?content=true) | 384 | 173 |
| [ElevenLabs](https://elevenlabs.io/careers) | [Ashby · elevenlabs](https://api.ashbyhq.com/posting-api/job-board/elevenlabs) | 207 | 33 |
| [Epic Games](https://www.epicgames.com/site/en-US/careers) | [Greenhouse · epicgames](https://boards-api.greenhouse.io/v1/boards/epicgames/jobs?content=true) | 154 | 19 |
| [Fivetran](https://www.fivetran.com/careers) | [Greenhouse · fivetran](https://boards-api.greenhouse.io/v1/boards/fivetran/jobs?content=true) | 192 | 59 |
| [Grafana Labs](https://grafana.com/careers/) | [Greenhouse · grafanalabs](https://boards-api.greenhouse.io/v1/boards/grafanalabs/jobs?content=true) | 148 | 59 |
| [Kong](https://konghq.com/careers) | [Ashby · kong](https://api.ashbyhq.com/posting-api/job-board/kong) | 78 | 19 |
| [Lyft](https://www.lyft.com/careers) | [Greenhouse · lyft](https://boards-api.greenhouse.io/v1/boards/lyft/jobs?content=true) | 175 | 65 |
| [Miro](https://miro.com/careers/) | [Greenhouse · realtimeboardglobal](https://boards-api.greenhouse.io/v1/boards/realtimeboardglobal/jobs?content=true) | 28 | 1 |
| [Mozilla](https://www.mozilla.org/en-US/careers/) | [Greenhouse · mozilla](https://boards-api.greenhouse.io/v1/boards/mozilla/jobs?content=true) | 74 | 34 |
| [N26](https://n26.com/en-eu/careers) | [Greenhouse · n26](https://boards-api.greenhouse.io/v1/boards/n26/jobs?content=true) | 67 | 22 |
| [Okta](https://www.okta.com/company/careers/) | [Greenhouse · okta](https://boards-api.greenhouse.io/v1/boards/okta/jobs?content=true) | 333 | 123 |
| [Palantir](https://www.palantir.com/careers/) | [Lever · palantir](https://api.lever.co/v0/postings/palantir?mode=json) | 321 | 197 |
| [Perplexity](https://www.perplexity.ai/hub/careers) | [Ashby · perplexity](https://api.ashbyhq.com/posting-api/job-board/perplexity) | 122 | 46 |
| [Plaid](https://plaid.com/careers/) | [Ashby · plaid](https://api.ashbyhq.com/posting-api/job-board/plaid) | 122 | 38 |
| [PostHog](https://posthog.com/careers) | [Ashby · posthog](https://api.ashbyhq.com/posting-api/job-board/posthog) | 8 | 5 |
| [Proton](https://proton.me/careers) | [Greenhouse · proton](https://boards-api.greenhouse.io/v1/boards/proton/jobs?content=true) | 62 | 39 |
| [Ramp](https://ramp.com/careers) | [Ashby · ramp](https://api.ashbyhq.com/posting-api/job-board/ramp) | 158 | 37 |
| [Replit](https://replit.com/careers) | [Ashby · replit](https://api.ashbyhq.com/posting-api/job-board/replit) | 75 | 29 |
| [Riot Games](https://www.riotgames.com/en/work-with-us) | [Greenhouse · riotgames](https://boards-api.greenhouse.io/v1/boards/riotgames/jobs?content=true) | 165 | 58 |
| [Runway](https://runwayml.com/careers) | [Ashby · runway-ml](https://api.ashbyhq.com/posting-api/job-board/runway-ml) | 44 | 13 |
| [Scale AI](https://scale.com/careers) | [Greenhouse · scaleai](https://boards-api.greenhouse.io/v1/boards/scaleai/jobs?content=true) | 203 | 78 |
| [Sentry](https://sentry.io/careers/) | [Ashby · sentry](https://api.ashbyhq.com/posting-api/job-board/sentry) | 41 | 21 |
| [ServiceNow](https://careers.servicenow.com/) | [SmartRecruiters · ServiceNow](https://api.smartrecruiters.com/v1/companies/ServiceNow/postings) | 701 | 178 |
| [Snowflake](https://careers.snowflake.com/) | [Ashby · snowflake](https://api.ashbyhq.com/posting-api/job-board/snowflake) | 349 | 107 |
| [Temporal](https://temporal.io/careers) | [Ashby · temporal](https://api.ashbyhq.com/posting-api/job-board/temporal) | 63 | 23 |
| [Together AI](https://www.together.ai/careers) | [Greenhouse · togetherai](https://boards-api.greenhouse.io/v1/boards/togetherai/jobs?content=true) | 78 | 43 |
| [Twilio](https://www.twilio.com/en-us/company/jobs) | [Greenhouse · twilio](https://boards-api.greenhouse.io/v1/boards/twilio/jobs?content=true) | 138 | 42 |
| [Twitch](https://www.twitch.tv/jobs/) | [Greenhouse · twitch](https://boards-api.greenhouse.io/v1/boards/twitch/jobs?content=true) | 59 | 17 |
| [Waymo](https://waymo.com/careers/) | [Greenhouse · waymo](https://boards-api.greenhouse.io/v1/boards/waymo/jobs?content=true) | 358 | 165 |
| [Wikimedia Foundation](https://wikimediafoundation.org/about/jobs/) | [Greenhouse · wikimedia](https://boards-api.greenhouse.io/v1/boards/wikimedia/jobs?content=true) | 13 | 4 |
| [xAI (SpaceXAI)](https://x.ai/careers) | [Greenhouse · xai](https://boards-api.greenhouse.io/v1/boards/xai/jobs?content=true) | 276 | 73 |
| [Zoox](https://zoox.com/careers/) | [Lever · zoox](https://api.lever.co/v0/postings/zoox?mode=json) | 241 | 120 |

추가된 공개 ID는 **8,814개**, 개발·컴퓨팅 후보는 **2,742개**입니다. 기존 36개 회사의 원문·조회 시각을 보존한 로컬 합계는 공개 ID **19,330개**, 후보 **6,067개**였습니다. 기존 자료까지 같은 시각에 다시 수집했다는 뜻은 아닙니다.

합친 본문 캐시는 54,212,691바이트로 현재 64 MiB 읽기 한도 안에 있습니다. 새 파일을 실제 캐시 읽기 경로로 다시 열어 83개 게시판과 모든 기존 기록·시각의 보존을 확인했습니다. 이전 캐시도 별도로 백업했습니다. 향후 회사 수나 본문이 늘면 저장 용량을 다시 확인해야 합니다.

Greenhouse의 `digitalocean98`, `automatticcareers`, `realtimeboardglobal`처럼 회사명과 다른 게시판 식별자, Ashby의 `ClickHouse`처럼 대소문자가 있는 경로를 실제 응답대로 등록했습니다. xAI 게시판의 표시 이름은 **SpaceXAI**여서 앱에는 **xAI (SpaceXAI)**로 표시합니다. 이 이름 대조가 법인 관계나 그룹 전체 채용 범위를 확정한 것은 아닙니다.

## 63단계에서 추가한 공식 게시판 3곳과 공개 잡 사이트 7곳

2026-09-26 16:06 UTC에 새 수집기로 10개사를 확인했습니다. Workable 3회와 Himalayas 12페이지, 총 15회 요청이 모두 정상 완료했습니다. 전체 공개 ID는 **370개**, 개발·컴퓨팅 후보는 **66개**입니다.

| 공식 커리어 사이트 | 실제 수집 출처 | 전체 공개 ID | 개발·컴퓨팅 후보 |
|---|---|---:|---:|
| [Hugging Face](https://huggingface.co/JOIN-US) | [공식 Workable · huggingface](https://apply.workable.com/api/v1/widget/accounts/huggingface?details=true) | 8 | 7 |
| [SmartNews](https://careers.smartnews.com/en/) | [공식 Workable · smartnews](https://apply.workable.com/api/v1/widget/accounts/smartnews?details=true) | 28 | 5 |
| [Mercari](https://careers.mercari.com/jobs/) | [공식 Workable · mercari](https://apply.workable.com/api/v1/widget/accounts/mercari?details=true) | 145 | 37 |
| [Microsoft](https://careers.microsoft.com/v2/global/en/home.html) | [Himalayas · microsoft](https://himalayas.app/jobs/api/search?company=microsoft&sort=recent&page=1) | 2 | 1 |
| [Adobe](https://careers.adobe.com/us/en) | [Himalayas · adobe](https://himalayas.app/jobs/api/search?company=adobe&sort=recent&page=1) | 17 | 2 |
| [Salesforce](https://www.salesforce.com/company/careers/) | [Himalayas · salesforce](https://himalayas.app/jobs/api/search?company=salesforce&sort=recent&page=1) | 108 | 3 |
| [Cisco](https://careers.cisco.com/global/en) | [Himalayas · cisco](https://himalayas.app/jobs/api/search?company=cisco&sort=recent&page=1) | 15 | 3 |
| [Qualcomm](https://careers.qualcomm.com/careers) | [Himalayas · qualcomm](https://himalayas.app/jobs/api/search?company=qualcomm&sort=recent&page=1) | 19 | 3 |
| [Broadcom](https://www.broadcom.com/company/careers) | [Himalayas · broadcom](https://himalayas.app/jobs/api/search?company=broadcom&sort=recent&page=1) | 11 | 3 |
| [Red Hat](https://www.redhat.com/en/jobs) | [Himalayas · red-hat](https://himalayas.app/jobs/api/search?company=red-hat&sort=recent&page=1) | 17 | 2 |

Workable은 공식 회사 페이지의 연결을 대조했고, 공식 도움말에 공개된 API를 사용합니다. 계정의 회사 이름과 각 공고의 shortcode·원문 주소를 검사합니다. 공개 응답에 포함되어도 숨김 위치는 오피스 주소나 원격 지원 가능 국가로 사용하지 않습니다.

Himalayas 7곳은 해당 사이트의 원격 공고 표본입니다. 각 회사의 공식 커리어 진입 페이지도 조사했지만 그 공식 목록 전체를 직접 수집하는 연동은 아직 구현하지 않았습니다. 회사 슬러그와 원문 경로, 모든 페이지의 총수·ID를 대조하며 회사 전체의 채용 규모로 표현하지 않습니다.

Himalayas의 API 전용 문서는 출처와 원문 링크를 표시하는 앱·잡 보드 이용을 허용합니다. 카드·상세·저장·가져오기·내보내기에 해당 출처와 원문 링크를 유지합니다. 하루 단위 갱신 안내에 맞춰 정상 조회 후 24시간 동안 재사용하며, 다른 잡 애그리게이터로 공고를 전송하지 않습니다.

선행 조사에서 NVIDIA·Netflix·Oracle·Dell·Workday·HubSpot은 응답의 총수에 비해 첫 페이지가 짧았습니다. AMD·Atlassian은 총 1건이라고 응답하면서 빈 배열을 반환했습니다. 현재 전체 목록 검증을 통과하지 못한 결과이므로 부분 자료를 정상 목록이나 채용 0건으로 추가하지 않았습니다.

62단계에서 확인된 재무 공고 1건을 개발 후보에서 제외한 기존 83개사의 **19,330개 공개 ID·6,066개 후보**에 새 결과를 합쳤습니다. 현재 로컬 합계는 **19,700개 공개 ID·6,132개 개발·컴퓨팅 후보**입니다. 이전 83개사의 본문·원문 URL·조회 시각·관측 기준은 모두 그대로이며, 같은 시각의 전수 재수집이나 분류 정확도 전수 검증을 뜻하지 않습니다.

이전 파일을 백업하고 동시 변경 여부와 64 MiB 읽기 한도를 확인한 뒤 기존 저장 경로로 반영했습니다. 최종 캐시는 **55,127,808바이트**이며 앱의 실제 읽기 경로로 다시 열어 93개사와 모든 보존 항목을 대조했습니다. 원 응답과 검증 자료는 `.local/research/63/`에만 보관합니다.


## 조사했지만 현재 수집 대상에 추가하지 않은 50곳

이 표는 현재 구현·확인 범위의 기록입니다. HTTP 200은 해당 진입 페이지를 읽었다는 뜻이며, 채용 목록 전체나 자동 재사용 권한을 확인했다는 뜻은 아닙니다. 아래 사유를 영구적인 수집 불가능 판정으로 해석하지 않습니다.

| 공식 커리어 사이트 | 첫 페이지 HTTP | 미등록 사유·확인 범위 |
|---|---:|---|
| [Google](https://www.google.com/about/careers/applications/jobs/results/) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [Apple](https://jobs.apple.com/en-us/search?location=united-states-USA) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [Amazon](https://www.amazon.jobs/en/) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [Meta](https://www.metacareers.com/jobsearch/) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [NVIDIA](https://www.nvidia.com/en-us/about-nvidia/careers/) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [Tesla](https://www.tesla.com/careers/search/) | 403 | 공식 페이지 HTTP 403. 이번 단계에서 검증한 별도 수집 경로 없음 |
| [Netflix](https://jobs.netflix.com/) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [Oracle](https://www.oracle.com/careers/) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [IBM](https://www.ibm.com/careers) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [SAP](https://jobs.sap.com/) | 403 | 공식 페이지 HTTP 403. 이번 단계에서 검증한 별도 수집 경로 없음 |
| [Intel](https://intel.wd1.myworkdayjobs.com/External/page/6042070b79e01001f04fa9b468070000) | 200 | 공식 Workday 채용 경로 확인. 현재 지원하는 수집기와 다른 규약 |
| [AMD](https://careers.amd.com/careers-home/jobs) | 200 | 공식 iCIMS 채용 경로 확인. 현행 전체 목록 수집 규약은 미확정 |
| [Dell](https://enterpriseplatform.dell.com/hcmUI/CandidateExperience/en/sites/careers) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [Workday](https://www.workday.com/en-us/company/careers/overview.html) | 200 | 공식 Workday 채용 경로 확인. 현재 지원하는 수집기와 다른 규약 |
| [Uber](https://jobs.uber.com/en/jobs/) | 403 | 공식 페이지 HTTP 403. 이번 단계에서 검증한 별도 수집 경로 없음 |
| [GitHub](https://www.github.careers/careers-home) | 200 | 공식 iCIMS 채용 경로 확인. 현행 전체 목록 수집 규약은 미확정 |
| [HubSpot](https://www.hubspot.com/careers/jobs) | 200 | 조회한 후보 게시판은 빈 목록. 회사 전체 채용이 0건이라는 근거로 사용하지 않음 |
| [Zoom](https://careers.zoom.us/) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [DuckDuckGo](https://duckduckgo.com/hiring) | 200 | 검토한 공개 게시판 후보 주소가 404. 현행 전체 목록 수집 경로는 미확정 |
| [Redis](https://redis.io/company/careers/) | 200 | 검토한 공개 게시판 후보 주소가 404. 현행 전체 목록 수집 경로는 미확정 |
| [dbt Labs](https://www.getdbt.com/about-us/careers) | 200 | 검토한 공개 게시판 후보 주소가 404. 현행 전체 목록 수집 경로는 미확정 |
| [HashiCorp](https://www.hashicorp.com/career) | 429 | 검토한 공개 게시판 후보 주소가 404. 현행 전체 목록 수집 경로는 미확정 |
| [Postman](https://www.postman.com/company/careers/) | 200 | 검토한 공개 게시판 후보 주소가 404. 현행 전체 목록 수집 경로는 미확정 |
| [Retool](https://retool.com/careers) | 200 | 검토한 공개 게시판 후보 주소가 404. 현행 전체 목록 수집 경로는 미확정 |
| [JetBrains](https://www.jetbrains.com/careers/jobs/) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [Rippling](https://www.rippling.com/careers) | 200 | 검토한 공개 게시판 후보 주소가 404. 현행 전체 목록 수집 경로는 미확정 |
| [Checkout.com](https://www.checkout.com/careers) | 200 | 조회한 후보 게시판은 빈 목록. 회사 전체 채용이 0건이라는 근거로 사용하지 않음 |
| [Klarna](https://www.klarna.com/careers/) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [Stability AI](https://stability.ai/careers) | 200 | 공개 API의 지원 URL이 HTTP여서 현 수집기의 HTTPS 검증에서 거절됨. 6건을 정상 빈 목록으로 바꾸지 않음 |
| [Unity](https://unity.com/careers) | 200 | 검토한 공개 게시판 후보 주소가 404. 현행 전체 목록 수집 경로는 미확정 |
| [Samsung](https://www.samsung.com/us/careers/) | 200 | 공식 Workday 채용 경로 확인. 현재 지원하는 수집기와 다른 규약 |
| [NAVER](https://recruit.navercorp.com/) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [Kakao](https://careers.kakao.com/) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [LY Corporation](https://www.lycorp.co.jp/en/recruit/) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [KRAFTON](https://www.krafton.com/careers/jobs/) | 403 | 공식 페이지 HTTP 403. 이번 단계에서 검증한 별도 수집 경로 없음 |
| [Rakuten](https://global.rakuten.com/corp/careers/) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [ByteDance](https://joinbytedance.com/) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [TikTok](https://lifeattiktok.com/search) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [Tencent](https://careers.tencent.com/en-us/home.html) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [Alibaba](https://talent.alibaba.com/) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [Baidu](https://talent.baidu.com/jobs/social) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [Huawei](https://career.huawei.com/reccampportal/portal5/index.html) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [Xiaomi](https://hr.xiaomi.com/) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [Revolut](https://www.revolut.com/careers/) | 403 | 공식 페이지 HTTP 403. 이번 단계에서 검증한 별도 수집 경로 없음 |
| [Shopify](https://www.shopify.com/careers) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [Atlassian](https://www.atlassian.com/company/careers) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [Zalando](https://jobs.zalando.com/en) | 200 | 검토한 공개 게시판 후보 주소가 404. 현행 전체 목록 수집 경로는 미확정 |
| [토스](https://toss.im/career/jobs) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [당근](https://careers.daangn.com/jobs/) | 200 | 공식 채용 페이지 확인. 자체 또는 별도 채용 시스템의 전체 목록·본문 수집 규약은 미확정 |
| [Snyk](https://snyk.io/careers/) | 200 | 검토한 공개 게시판 후보 주소가 404. 현행 전체 목록 수집 경로는 미확정 |

Stability AI에서는 원문 API가 반환한 HTTP 지원 URL 때문에 기존 검사가 실패했습니다. HTTPS로 임의 변경하거나 필수 URL 검사를 낮추어 추가하지 않았습니다. 404·429·불완전한 결과도 최초 응답과 함께 남겼습니다.

## 공개 잡 사이트 12곳

| 사이트 | 확인한 공개 경로·조건 | 현재 판단 |
|---|---|---|
| [Himalayas](https://himalayas.app/docs/remote-jobs-api) | 인증 없는 조회 API, 회사 슬러그 필터·전체 페이지 조회, API 데이터의 출처 표시와 보이는 역링크 요구 | 7개사 보충 수집 구현. API 전용 사용 조건에 따라 출처·원문 링크와 24시간 재조회 간격 적용 |
| [Arbeitnow](https://www.arbeitnow.com/api/job-board-api) | 공개 JSON API에서 목록·다음 페이지 확인, 독일 채용 중심 | 별도 표본. 현재 회사별 완전한 게시판과 그대로 합칠 수 있는지 추가 확인 필요 |
| [Remotive](https://github.com/remotive-com/remote-jobs-api) | 활성 원격 공고 API, 출처·원문 링크 요구, 24시간 지연, 권장 하루 최대 4회, 제3자 사이트 재전송 제한 | 사용 조건과 지연을 반영하는 별도 연동 대상 |
| [Remote OK](https://remoteok.com/api) | 공개 API의 첫 항목에 원문 역링크·출처 표시와 로고 사용 조건 명시 | 받은 최신 목록 밖의 공고를 종료로 판단할 수 없어 회사별 전체 목록 확인과 분리 필요 |
| [We Work Remotely](https://weworkremotely.com/remote-jobs.rss) | 공개 RSS 확인 | 최신 피드의 누락을 게시 종료로 취급하지 않는 별도 규약 필요 |
| [Jobicy](https://jobicy.com/jobs-rss-feed) | 앱·잡보드 이용을 허용하는 공개 API 안내, 출처 표시·캐시 권장, 직접 ATS 링크에는 별도 상용 접근 | 목록의 범위와 종료 확인을 현재 전체 게시판 수집과 구분해 설계할 대상 |
| [The Muse](https://www.themuse.com/developers/api/v2/terms) | API 약관에서 앱 등록 요구, 역링크·제품 복제 제한 등 명시 | 등록·사용 범위 확인 없이 수집기로 추가하지 않음 |
| [Adzuna](https://developer.adzuna.com/overview) | 개발자 등록·인증 정보가 필요한 API | 별도 계정·API 권한 필요 |
| [USAJOBS](https://developer.usajobs.gov/) | 공식 개발자 API와 이용 조건 안내 | 인증이 필요한 검색 API이며 유명 IT 기업의 자사 게시판과 다른 연방정부 채용 표본 |
| [Wellfound](https://wellfound.com/jobs) | 공개 검색 진입 페이지 확인 | 이 조사에서 일반 재사용용 전체 목록 API를 확인하지 못함 |
| [Y Combinator](https://www.ycombinator.com/jobs) | 공개 스타트업 채용 페이지 확인 | 이 조사에서 일반 재사용용 전체 목록 API를 확인하지 못함 |
| [Indeed](https://docs.indeed.com/) | 공식 개발자 문서 진입에서 HTTP 403 | 이 조사 환경에서 문서·사용 가능한 데이터 연동 권한을 확인하지 못함 |

여러 잡 사이트의 재게시물을 단순 합산하면 같은 포지션을 중복 집계하거나 회사 전체 채용을 과장할 수 있습니다. 현재 기본 목록은 공식 게시판 86곳과 Himalayas 7곳을 구분합니다. 같은 회사의 여러 잡 사이트 자료를 중복 추가하지 않습니다. LinkedIn의 직접 자동 수집은 별도 조사에서 확인한 접근 조건 때문에 포함하지 않았습니다.

## 관련 문서

- [공개 게시판 설정과 실행](../README.md)
- [게시 확인과 본문 갱신의 분리](posting-presence.md)
- [관측 기록의 구성·분류 기준과 비교 조건](catalog-observations.md)
- [구현·독립 검증 기록](improvements.md)
