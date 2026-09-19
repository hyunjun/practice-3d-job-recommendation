# 레퍼런스를 반영한 부분

기획 문서의 마지막 수정안인 **샘플 탐색 → 경력·필수조건 입력 → 도시별 회사 수 → 회사와 공고 확인 → 저장·지원 페이지**를 중심으로 구현했습니다.

| 레퍼런스 | 확인한 자료 | ORBIT에 적용한 부분 |
| --- | --- | --- |
| [Google Earth](https://earth.google.com/web/) | 공간 탐색의 조작 방식 | 드래그 회전, 확대·축소, 도시로 카메라 이동, 북쪽·초기 위치 복귀 |
| [Crucix](https://github.com/calesthio/Crucix) | README, 실제 대시보드·3D 지구 이미지 | 어두운 지구, 절제된 광원과 경계선, 지구·평면 전환, 지역별 이동, 지도와 정보 패널 분리 |
| [OSIRIS](https://github.com/simplifaisoul/osiris) | README와 시스템 구성 설명. 원문에 기재된 `osirisai.live`는 조사 시 응답 지연으로 직접 열리지 않았음 | 공간 데이터와 조회 상태의 구분, 서버를 통한 공개 데이터 조회, 화면과 수집 로직 분리 |
| [Shadowbroker](https://github.com/BigBodyCobain/Shadowbroker) | README와 인터페이스 구성 | 지도 중심 화면, 독립적인 정보 패널, 조회 범위와 출처를 확인할 수 있는 구조 |
| [제주 아틀라스](https://jeju-atlas.whchoi.net/) / [저장소](https://github.com/whchoi98/jeju-atlas) | README, 실제 검색 화면, 모바일 화면 설명, 로컬 실행 구성 | 지도·목록·상세 선택 연동, 저장 후 재방문, 모바일에서 지도와 결과를 이어 보는 흐름, 로컬 자산과 API 분리 |
| [3D 제작 사례 기사](https://www.koreafuture.co.kr/m/view.php?idx=32441&mcode=) | 기사 본문 | 실제 데이터와 인터랙션을 구현한 뒤 브라우저에서 검증하는 방향 |

레퍼런스의 UI 패턴을 참고해 화면과 코드를 새로 작성했습니다. OSINT 데이터나 감시 기능은 포함하지 않습니다.

## 기획의 집계 규칙

- 도시 마커는 공고 수가 아니라 **관련 공고가 있는 고유 회사 수**입니다.
- 묶음 마커와 전체 합계에서도 회사를 중복 제거합니다.
- 원격근무는 도시의 본사 위치와 분리합니다.
- 비자, 연봉, 근무 형태에 대해 미확인 상태를 보존합니다.
- 지구 뒤에 가려진 결과를 놓치지 않도록 도시 목록을 제공합니다.
- 지도에 없다고 채용 기회가 없다는 인상을 주지 않도록 지도에 표시하는 22개 도시·대상 회사·조회 상태를 표시하고, 연결되지 않은 공고도 기타 근무지에서 제공합니다.
- 샘플과 실제 조회를 명확하게 구분합니다.
- 이력서의 기술 추출 결과를 확인·수정한 뒤 추천에 적용합니다.

## 이번 구현의 경계

3D 건물, 생활비·이주 점수, 합격 확률, LinkedIn 자동 수집, 자동 지원, 신규 공고 알림은 포함하지 않았습니다. 다음 개발 시 기존의 데이터 계약을 유지하며 수집기와 추천 엔진을 확장할 수 있습니다.

## 공개 공고 수집

| 레퍼런스 | 확인한 규칙 | 반영 |
| --- | --- | --- |
| [Greenhouse Job Board API](https://developers.greenhouse.io/job-board.html) | 공개 GET 조회, 공고별 `metadata`·`offices`, `pay_transparency`, 급여 구간의 통화·제목·설명문 | 실제 근무지와 보상 조건의 원문 근거, 기존 10개 회사 수집 |
| [Ashby Public Job Posting API](https://developers.ashbyhq.com/docs/public-job-posting-api) | `isListed`, `workplaceType`, `employmentType`, `secondaryLocations`, `includeCompensation=true`와 보상 구간 | 목록 비공개 공고 제외, 추가 근무지와 국가 주소, 기본 급여·통화·기간 보존, 5개 회사 수집 |
| [Lever Postings API](https://github.com/lever/postings-api) | 공개 공고 배열, `limit`·`skip`, `allLocations`, `commitment`, `salaryRange.interval`, EU 주소 | 전체 페이지 성공 후 반영, 계약 기간과 근무 시간 구분, 2개 회사 수집 |
| [SmartRecruiters Posting API](https://developers.smartrecruiters.com/docs/posting-api) | 공개 게시 목록과 상세의 별도 조회, 국가·도시·원격·하이브리드 필드, 공개 고용 형태 이름 | Canva·Grab·Wise 추가, 전체 공개 목록과 필요한 본문 확인, 근무 조건의 공개 근거 보존 |
| [Google JobPosting 구조화된 데이터](https://developers.google.com/search/docs/appearance/structured-data/job-posting) | 실제 고용주가 제공한 `baseSalary`, 통화와 `HOUR`·`DAY`·`WEEK`·`MONTH`·`YEAR`, 고정 금액과 범위 | 기본 급여·총보상 구분, 지급 기간 확인, 임의 연봉 환산 제외 |
| [Schema.org baseSalary](https://schema.org/baseSalary) | 직무나 직원의 기본 급여 | 기본 급여와 그 밖의 보상을 분리하는 데이터 계약 |
| [MDN Retry-After](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After) | 초 단위와 HTTP 날짜 형식 | 게시판별 재조회 대기 시각 |
| [RFC 5861 §4](https://www.rfc-editor.org/rfc/rfc5861.html#section-4) | 오류 시 제한된 기간 동안 이전 정상 결과 사용 | 원래 조회 시각 보존, 24시간 이후 추천 제외 |

실제 응답과 함께 검증했습니다. API 문서의 선택 필드는 누락될 수 있고, 공개 게시판은 회사가 다른 서비스로 옮기면 바뀔 수 있습니다. 조사 시 Mistral AI의 기존 Lever 게시판은 빈 목록이었으며, [공식 채용 페이지](https://mistral.ai/careers)가 연결한 Ashby의 `mistral.ai` 게시판을 사용합니다. 응답 구조와 조회 상태를 검증하고, 해석하지 못한 지원 국가나 보상 조건을 임의로 채우지 않습니다. 적용 결과와 검증 시점은 [개선 기록](improvements.md)에 남깁니다.

Greenhouse 문서는 단일 공고 조회의 `pay_transparency=true`를 설명합니다. 실제 목록 API에서도 이 옵션으로 `pay_input_ranges`가 반환되는 것을 확인해 사용하며, 목록 조회에서의 지원을 문서상 보장으로 간주하지 않습니다. 구조화된 구간이 없으면 본문을 확인하고, 어느 경로에서도 통화·지급 기간을 확인하지 못한 금액은 그대로 미확인으로 남깁니다. Google·Schema.org 자료는 보상 데이터의 의미를 정하는 데 참고했으며, 검색 엔진용 구조화된 데이터를 발행하는 기능은 아닙니다.

## 지도에 연결되지 않은 근무지

| 레퍼런스 | 확인한 구분 | 반영 |
| --- | --- | --- |
| [Greenhouse Job Board API](https://developers.greenhouse.io/job-board.html) | 공고의 `location`과 연결된 `offices`, 오피스의 상위·하위 관계는 서로 다른 필드 | 국가명·`N/A`·제공 범위 밖 도시를 다른 오피스로 치환하지 않고 원문 위치 유지 |
| [Google JobPosting의 jobLocation](https://developers.google.com/search/docs/appearance/structured-data/job-posting#joblocation) | 직원이 실제로 출근하는 근무지, 원격 여부와 원격근무 지역은 별도 속성 | 좌표가 없는 공고를 원격근무로 해석하거나 회사 본사에 표시하지 않음 |

2026-09-19 공개 응답에는 도시명만 있는 공고, 국가만 기재한 공고, `N/A`가 함께 있었습니다. 공고 위치가 `Cork, Ireland`인데 연결된 오피스는 Dublin인 사례도 확인했습니다. 이에 지도에 연결되지 않은 개발 공고를 수집 단계에서 제거하던 규칙을 바꾸고, **기타 근무지**에서 원문 위치·근무 형태와 함께 검색·열람·저장하도록 했습니다.

지도 표시 범위와 공고 수집 범위는 구분합니다. 기타 근무지는 현재 전 세계 범위에서만 표시하고, 지역을 해제하는 변경안에는 범위가 넓어진다는 설명을 붙입니다. 기존 캐시에 개수만 남아 있는 공고는 실제 열람 가능한 목록으로 계산하지 않으며 다음 정상 조회에서 갱신합니다. 이 화면 구성은 자료의 구분과 실제 응답을 바탕으로 정한 제품 설계이며, 제공자가 요구하는 특정 UI 규칙은 아닙니다.

## 세부 직무와 미확인 분류

| 레퍼런스 | 확인한 의미 | 반영 |
| --- | --- | --- |
| [O*NET: Software Developers, 15-1252.00](https://www.onetonline.org/link/summary/15-1252.00) | Software Engineer·Application Developer·Infrastructure Engineer 등 여러 직함과 업무를 포함하는 직업군 | 일반적인 Software Engineer라는 제목만으로 풀스택 업무를 추정하지 않음 |
| [MDN: Introduction to the server side](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Server-side/First_steps/Introduction) | 클라이언트·서버 코드의 역할과 실행 환경 구분, JavaScript는 양쪽에서 사용 가능 | 기술 언어만으로 백엔드·프론트엔드·풀스택 담당 여부를 정하지 않음 |
| [Ashby Public Job Posting API](https://developers.ashbyhq.com/docs/public-job-posting-api) | 공고별 `title`, `department`, `team` | 제목이 일반적일 때 공개 부서·팀의 명시적인 전문 분야를 보조 근거로 보존 |
| [Lever Postings API](https://github.com/lever/postings-api) | 공고의 `text`, `categories.team`, `categories.department` | 응답 검증에서 부서·팀 필드를 유지하고 다른 제공자와 같은 분류 규칙 적용 |

17개 게시판의 실제 제목·부서를 대조했습니다. 기존에는 분류 규칙에 걸리지 않는 제목을 모두 풀스택으로 취급했습니다. 이제 제목에서 확인한 직무가 있으면 더 넓은 부서 표기로 덮어쓰지 않고, 여러 직무 표기는 함께 보존합니다. 특정할 수 없는 공고는 **세부 직무 미확인**으로 남겨 계속 탐색할 수 있게 했습니다. Greenhouse의 공고별 `departments`도 실제 응답에서 확인해 보조 정보로 사용합니다.

O*NET 직업 코드를 공고에 자동 부여하거나 이 규칙의 정확도를 보증하는 자료로 사용하지 않았습니다. 일반 직업군·웹 개발 업무·게시판 필드의 의미를 구분하는 근거로 참고했으며, 제목·부서의 키워드 분류 자체는 ORBIT의 탐색 설계입니다. 실제 업무·직급·개발 직군 여부는 추가 검증이 필요합니다.

## 개발·컴퓨터 연구와 다른 직군의 구분

| 레퍼런스 | 확인한 의미 | 반영 |
| --- | --- | --- |
| [O*NET: Computer and Information Research Scientists, 15-1221.00](https://www.onetonline.org/link/summary/15-1221.00) | 컴퓨터·정보 과학의 연구와 컴퓨터 하드웨어·소프트웨어 문제 해결, Research Scientist 등 여러 직함 | `Engineer`가 없는 연구 직함도 확인하되 실제 공고의 컴퓨팅 업무·자격 근거 보존 |
| [O*NET: Computer User Support Specialists, 15-1232.00](https://www.onetonline.org/link/summary/15-1232.00) | 사용자의 하드웨어·소프트웨어 문제에 기술적 도움을 제공하는 업무 | 기술지원 부서의 서비스·에스컬레이션 엔지니어와 지원 제품을 개발하는 엔지니어 구분 |
| [O*NET: Computer and Information Systems Managers, 11-3021.00](https://www.onetonline.org/link/summary/11-3021.00) | 정보 시스템·프로그래밍 등의 활동을 계획·지휘·조정하는 관리 업무 | 공개 직급의 `People Manager`와 명시적인 관리 업무를 확인하고 Lead·멘토링만으로 관리자라고 판단하지 않음 |

2026-09-19의 공개 응답에서 MongoDB의 `Technical Support` 부서와 `Job Level: People Manager`, Stripe의 지원 제품 개발직, Datadog·Mistral·Spotify 등의 연구 공고를 대조했습니다. Anthropic의 생명과학 공고에서도 컴퓨팅 파이프라인 개발과 화학 실험 업무가 서로 달랐습니다. 따라서 회사·부서에 AI가 있다는 이유로 모든 연구직을 개발·컴퓨터 연구로 취급하지 않습니다.

위 자료는 직업의 업무 범위를 이해하는 참고 자료입니다. 국가별 직업 자격이나 관리직의 법적 지위를 판정하거나 O*NET 코드를 자동으로 부여하지 않습니다. ORBIT의 수집 범위와 근거 추출 규칙은 이 자료와 실제 공개 공고를 참고한 제품 설계이며 모든 직함을 검증한 분류 체계는 아닙니다. 연구직 포함 여부와 세부 AI·머신러닝 분류도 구분하며, 본문 보완에는 해당 공고의 업무·자격 근거만 사용합니다.

## 기술·경력의 추천 근거

| 레퍼런스 | 확인한 의미 | 반영 |
| --- | --- | --- |
| [Schema.org qualifications](https://schema.org/qualifications) | 해당 직무에 필요한 구체적인 자격 | 회사 소개와 지원자 자격 항목을 분리하고 원문 보존 |
| [Schema.org skills](https://schema.org/skills) | 개인·조직이 보유하거나 직무에서 요구·선호하는 역량 | 기술 단어의 등장만으로 필수 경험을 추정하지 않음 |
| [Google JobPosting 경력 요구사항](https://developers.google.com/search/docs/appearance/structured-data/job-posting) | 직무에 필요한 경력 개월 수, 여러 조건의 AND·OR 차이, 학력 대신 인정하는 경력 | 필수·우대 연수 분리, 월·연 단위 보존, 학력·분야별 선택 경로의 원문 표시 |
| [Schema.org experienceRequirements](https://schema.org/experienceRequirements) | 해당 직무에 필요한 경력의 설명 | 입사 후 목표 기간·회사 연혁·학업 기간을 요구 경력에서 제외 |

Stripe의 `Minimum requirements`·`Preferred qualifications`, MongoDB의 `Key Qualifications`·`Nice-to-Have Skills`, Anthropic의 `Strong candidates may also have`, Ashby·Lever 공고의 자격 제목과 실제 문장을 함께 확인했습니다. 제목과 문구로 확인할 수 있는 범위에서 구분하며, 일반 자격 항목을 반드시 충족해야 하는 조건으로 단정하지 않습니다.

문서는 데이터 의미와 복합 조건을 구분하는 기준으로 사용했습니다. 특정 본문 파서나 추천 가중치의 정확성을 보장하는 자료는 아닙니다. ORBIT은 명확한 기술 선택 관계만 비교에 반영하고, 혼합된 예시·선택 관계와 학력별 경력 경로는 원문 확인을 남깁니다.

## 저장한 공고의 게시 상태

| 레퍼런스 | 확인한 의미 | 반영 |
| --- | --- | --- |
| [Greenhouse Job Board API](https://developers.greenhouse.io/job-board.html) | 조직의 공개된 공고 목록, 목록의 `meta.total` | 직무·근무지 필터 전 전체 ID 보관, 제공된 전체 건수와 응답 길이가 다르면 실패 처리 |
| [Ashby Public Job Posting API](https://developers.ashbyhq.com/docs/public-job-posting-api) | 현재 게시된 공고와 `isListed`의 공개 목록 표시 여부 | 목록 비공개 공고는 제외하고 나머지 전체 ID로 게시 여부 확인 |
| [Lever Postings API](https://github.com/lever/postings-api) | `published` 상태 공고의 `skip`·`limit` 페이지 조회 | 전체 페이지 확인 후 중복 없는 목록 반영, 중간 페이지 실패 시 이전 목록 유지 |
| [Google JobPosting의 공고 제거](https://developers.google.com/search/docs/appearance/structured-data/job-posting#remove-job-posting) | 만료된 `validThrough`, 404/410 응답, 구조화된 데이터 제거 등 여러 종료 처리 방식 | 상세 페이지가 열리는 것만으로 모집 중이라 단정하지 않음. 공개 목록에서 미확인과 채용 종료를 구분 |

공개 목록의 게시 여부는 원문에서 현재 지원을 받는다는 보장이 아닙니다. 회사가 게시판을 옮기거나 목록 표시를 바꿀 수 있고, 페이지를 나누어 조회하는 동안에도 공고가 바뀔 수 있습니다. 따라서 ORBIT은 최근 같은 게시판의 전체 목록에 포함되어 있는지만 표시하고 종료를 확정하지 않습니다.

저장 내용의 비교는 브라우저가 보관한 표시 항목을 기준으로 합니다. 수집 시각·저장 메모·지원 상태·배열 순서·서식 공백은 비교에서 제외하며, 원문 변경과 정규화 방식의 변화는 구별할 수 없으므로 **저장 내용과 차이**로 표현합니다. 서버에 저장한 공고나 개인 정보를 전송하지 않습니다.

## 취업 자격과 비자 지원 범위

| 레퍼런스 | 확인한 의미 | 반영 |
| --- | --- | --- |
| [Schema.org eligibilityToWorkRequirement](https://schema.org/eligibilityToWorkRequirement) | 지원자에게 필요한 시민권·비자·기타 서류 등의 법적 요건 | 비자 지원 정책과 추가 취업 자격을 구분하고 원문 보존 |
| [Google JobPosting의 applicantLocationRequirements](https://developers.google.com/search/docs/appearance/structured-data/job-posting#applicant-location-requirements) | 재택근무가 가능한 지원자의 지리적 위치 | 원격근무 지역과 거주 국가만 비교하며 법적 취업 자격을 충족했다고 표시하지 않음 |
| [GOV.UK: Prove your right to work to an employer](https://www.gov.uk/prove-right-to-work) | 취업 권한의 증명 방식은 국적과 체류·취업 권한에 따라 다름 | 거주 국가를 취업 허가나 국적으로 간주하지 않음 |
| [USCIS: Working in the United States](https://www.uscis.gov/working-in-the-united-states) | 취업 관련 비자 분류와 고용 허가의 여러 경로 | 비자 스폰서십 문구만으로 지원자의 취업 권한을 판정하지 않음 |
| [22 CFR §120.62 — U.S. person, Cornell LII](https://www.law.cornell.edu/cfr/text/22/120.62) | 해당 규정의 U.S. person에는 영주권자와 보호 대상자도 포함됨 | 수출 통제의 U.S. person 요건을 미국 시민권만의 조건으로 바꾸지 않음 |

실제 n8n 공고의 독일 한정 비자 지원, Anthropic의 필수 시민권·우대 보안 인가, MongoDB·GitLab의 시민권 문구, Airbnb의 주별 거주 제한과 Cloudflare의 수출 허가 조건을 확인했습니다. 특정 조건의 적용 범위와 필수·우대를 보존하고, 차별 금지 문구·개인정보 수집 목록·증명 수단의 예시를 필수 자격으로 오인하지 않도록 반영했습니다.

이 자료는 데이터 의미를 구분하는 기준입니다. ORBIT은 법률을 자동 적용하거나 지원자의 국적·취업 허가를 추정하지 않습니다. 영어 원문의 명시적인 문구만 해석하며, 조건을 찾지 못한 경우에도 제한이 없다고 판단하지 않습니다.

## 빈 검색 결과에서 탐색 이어가기

| 레퍼런스 | 확인한 원칙 | 반영 |
| --- | --- | --- |
| [NN/g: Designing Empty States in Complex Applications](https://www.nngroup.com/articles/empty-state-interface-design/) | 시스템 상태를 정확히 설명하고 현재 작업의 다음 경로를 제공 | 조회 대기·오류·수집 범위·필터 결과를 구분하고 다른 도시·원격 기회로 연결 |
| [Baymard: No Results Pages](https://baymard.com/research-articles/no-results-page) | 검색어를 지워도 다시 빈 결과일지 모르는 불확실성, 맥락을 유지한 탐색 경로의 필요 | 현재 공고로 변경 후 후보 수를 계산하고 다른 조건은 유지 |
| [PatternFly: Empty state](https://www.patternfly.org/components/empty-state/design-guidelines/) | 비어 있는 이유와 다음 행동을 간결하게 제시 | 실제로 후보가 생기는 변경안과 직접 조건 조정·수집 범위 확인 |
| [WCAG 2.2: Understanding Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html) | 검색 결과 상태와 작업 완료를 보조 기술에 전달하되 불필요하게 방해하지 않음 | 입력 중에는 포커스를 유지하고, 명시적 변경 후 결과 영역으로 이동하며 상태 알림과 실행 취소 제공 |

Baymard 자료는 전자상거래 검색 연구입니다. 채용 서비스의 전환율이나 개선 효과를 입증하는 자료로 사용하지 않았습니다. ORBIT에서는 비자·보상·거주 국가 조건의 중요도를 임의로 판단하지 않고 변경 항목을 먼저 공개하며, 사용자가 선택한 경우에만 적용합니다.

## 공개 데이터의 전송과 HTTP 재검증

| 레퍼런스 | 확인한 동작 | 반영 |
| --- | --- | --- |
| [Express: Production best practices — performance](https://expressjs.com/en/advanced/best-practice-performance.html) | 응답 압축으로 본문 크기 감소, 큰 서비스에서는 프록시 압축 권장 | 로컬 Express 서버에서 공개 JSON과 배포용 정적 응답 압축 |
| [Express compression](https://github.com/expressjs/compression#readme) | `Accept-Encoding` 협상, 압축 임계값과 Brotli·gzip 옵션 | 검증된 미들웨어로 형식 선택, 1KB 임계값·Brotli 품질 4·gzip 수준 6 |
| [MDN: Cache-Control](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control) | `no-cache`는 저장을 허용하지만 재사용 전 검증 필요, `private`는 공유 캐시 저장 방지 | 공개 API의 정상 응답만 브라우저 저장·재검증 허용, 실패 응답은 `no-store` |
| [MDN: If-None-Match](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/If-None-Match) | ETag 조건이 일치하는 GET·HEAD의 본문 없는 `304` 응답 | 수집 서비스의 상태 확인 후 응답 전체를 비교하고 변경 없을 때 본문 전송 생략 |
| [MDN: Content-Encoding](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Encoding) · [Vary](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Vary) | 지원하는 인코딩 협상과 캐시 키 구분, `304`에도 같은 `Vary` 필요 | 압축을 풀면 원래 JSON과 같음을 검증하고 압축·비압축·조건부 응답에 같은 헤더 유지 |

2026-09-19 실제 공개 공고 960개를 담은 JSON의 전송 본문이 약 8.80MB였습니다. 원문과 추천 근거를 유지하면서 전송량을 줄이기 위해 압축을 적용했고, 브라우저의 재조회는 항상 서버 검증을 거치게 했습니다. 개인별 공고 요청을 추가하지 않으므로 프로필·검색 조건·저장한 공고 ID는 계속 브라우저 안에서 처리합니다.

HTTP 재검증은 게시판의 실시간 채용 상태를 보증하지 않습니다. 기존 수집 주기·재시도·24시간 보존 한도와 원래 조회 시각을 따르며, 새 정상 조회로 시각이 바뀌면 새 본문을 반환합니다. 이 정책은 네트워크 응답의 재사용에 적용합니다. 화면 복원과 시간 경과 처리는 아래의 별도 동작이며, 백그라운드 자동 수집은 하지 않습니다. 전송 바이트 감소를 서버 처리 시간이나 전체 화면 로딩 속도의 동일한 감소로 해석하지 않습니다.

## 열린 화면과 뒤로 가기 복원의 조회 기록

| 레퍼런스 | 확인한 동작 | 반영 |
| --- | --- | --- |
| [Chrome: Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api?hl=en) | 정지된 페이지의 타이머·콜백은 실행되지 않을 수 있으며, 메모리에서 복원한 문서는 새 로드와 다름 | 타이머 횟수로 경과 시간을 계산하지 않고 복원 시 원래 조회 시각과 현재 시각 비교 |
| [MDN: visibilitychange](https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event) | 다른 탭·앱으로 전환하거나 다시 표시될 때의 상태 변화 | 숨겨진 화면에서는 예약 타이머를 멈추고 다시 표시되면 시각 확인 |
| [MDN: pageshow](https://developer.mozilla.org/en-US/docs/Web/API/Window/pageshow_event) | 뒤로 가기·앞으로 가기 복원, `persisted`로 메모리 캐시 복원 확인 | 기존 화면이 그대로 돌아와도 공고의 30분·24시간 경계와 게시 확인 유효 기간 재평가 |
| [MDN: setTimeout](https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout) | 비활성 탭의 지연·제한과 최대 타이머 간격 | 다음 상태 변경 시각에 하나의 타이머를 예약하고 화면 복원·포커스에서도 시간 확인 |
| [MDN: Request.cache](https://developer.mozilla.org/en-US/docs/Web/API/Request/cache) | `no-store` 요청은 HTTP 캐시 조회·저장을 모두 생략 | 게시 상태 버튼의 별도 `no-store` 옵션을 제거하고 서버의 필수 재검증 정책 사용 |

페이지 복원 시 외부 게시판을 자동 조회하지 않습니다. 현재 보관한 공개 기록이 얼마나 오래됐는지만 다시 계산하고, 30분 이후의 이전 조회·24시간 이후 추천 제외와 재조회 경로를 보여줍니다. 회사별 원래 시각·실제 실패 기록·재시도 시각은 유지하고 저장한 공고의 모집 종료를 추정하지 않습니다.

브라우저 검사에서 타이머 없이 시각만 이동한 뒤 복원 이벤트를 처리하는 경우를 확인했습니다. 별도의 Chrome 검증에서는 실제 뒤로 가기를 실행해 `pageshow.persisted: true`와 카탈로그 추가 요청 없음을 확인했습니다. 이는 확인 기간의 적용을 검증한 결과이며 브라우저가 항상 페이지를 메모리 캐시에 보관한다는 보장은 아닙니다.

## SmartRecruiters의 목록·상세와 지역 커버리지

| 레퍼런스 | 확인한 동작 | 반영 |
| --- | --- | --- |
| [Public postings 목록](https://developers.smartrecruiters.com/reference/v1listpostings) | 인증 없는 조회 허용, `destination=PUBLIC`, 페이지당 최대 100개, `offset`·`totalFound` | 회사별 모든 공개 페이지를 확인하며 전체 수 변경·중복·짧은 페이지를 불완전한 조회로 처리 |
| [공고 상세](https://developers.smartrecruiters.com/reference/v1getposting) · [Endpoints](https://developers.smartrecruiters.com/docs/endpoints) | 목록은 일부 필드만 포함, 상세에서 본문 제공, 게시 내용 갱신에는 재게시 필요 | 개발·연구 후보의 본문을 별도 조회하고 회사·ID·게시 버전을 대조, 일반 연구 직함도 본문 확인 |
| [Posting objects](https://developers.smartrecruiters.com/docs/objects) | `active`는 게시 중인지 게시 해제됐는지 구분 | 회사·ID가 일치하는 상세가 비활성·내부 게시임을 명시하면 공개 ID에서 제외하고, 통신 실패와 구분 |
| [공고 위치](https://developers.smartrecruiters.com/docs/location) · [공고 상세 스키마](https://developers.smartrecruiters.com/reference/v1getposting) | ISO 국가 코드, 도시·지역, `remote`·`hybrid`, 보상 금액·통화·기간 | 동명 도시 오연결 방지, 근무 형태가 충돌하면 미확인, 기본 급여 여부가 없는 보상은 연봉 비교에서 제외 |
| [Throttling policies](https://developers.smartrecruiters.com/docs/throttling-policies) | Customer API의 요청 속도·동시성 제한, `429`와 재시도 안내 | 제공자별 공통 대기열, 시작 간격 200ms·동시 4개, `Retry-After`와 취소·조회 한도 적용 |

공개 목록·상세 API의 인증 없는 조회를 확인하고 공개 목록에 `destination=PUBLIC`을 명시했습니다. Customer API 문서의 인증 고객용 할당량을 익명 Posting API의 보장된 한도로 해석하지 않습니다. 이 프로젝트의 한 프로세스 안에서 요청 속도와 동시성을 제한하며, 처음 확인하는 게시판은 개별 본문 조회 때문에 시간이 더 필요합니다.

2026-09-19 Canva·Grab·Wise의 실제 공개 API 응답을 대조했습니다. Grab에는 목록에 남아 있지만 상세가 `active: false`이고 원문도 만료로 표시하는 항목이 있었습니다. 유효한 비활성 응답은 해당 공고를 제외할 근거가 되며, 실패하거나 해석할 수 없는 응답은 새 목록이 완성됐다고 간주하지 않습니다.

Wise의 `User Researcher`가 AI 도구를 사용하는 업무 문구 때문에 컴퓨터 연구직으로 포함되는 사례도 확인했습니다. 사용자·시장·사람 연구의 명시적인 직함은 해당 분야로 구분하도록 보완했습니다. 기존 분류 버전도 읽고 재평가하며, 보관된 부서·관리자 근거와 본문 길이 한도 밖의 원문 근거를 보존합니다. 재해석은 새 수집으로 취급하지 않고 저장 메모·지원 상태·원래 조회 시각을 유지합니다.

## 전체 수집을 기다리지 않는 탐색

| 레퍼런스 | 확인한 내용 | 반영 |
| --- | --- | --- |
| [RFC 7240 §4.1: respond-async](https://www.rfc-editor.org/rfc/rfc7240.html#section-4.1) | 클라이언트가 비동기 응답을 선호함을 알리고 서버가 `202`와 후속 주소로 응답할 수 있음 | 기존 카탈로그 요청에 선택적으로 적용하며 기존 전체 JSON 응답도 유지 |
| [MDN: 202 Accepted](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/202) | 요청을 받아들였다는 응답이며 처리 완료·성공을 보장하지 않음 | 수집 시작과 정상 완료를 구분하고, 전부 실패한 수집을 정상 빈 목록으로 표시하지 않음 |
| [MDN: progressbar role](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/progressbar_role) | 네이티브 `progress`, 접근 가능한 이름, 범위에 맞는 현재 값과 필요한 `aria-valuetext` | 처리된 회사 수로 진행을 표시하고 남은 시간·성공률처럼 표현하지 않음 |

2026-09-19 원문을 확인했습니다. RFC는 구체적인 진행 확인·결과 병합 방식을 정하지 않으므로 [회사별 변경분 계약](catalog-progress.md)은 이 프로젝트에서 정의했습니다. 진행을 읽는 요청은 외부 게시판의 재조회와 분리하고, 완료된 회사의 공고만 추가 전송합니다. 연결 오류·취소 후에는 이미 받은 결과와 저장 기록을 유지하며 진행 번호가 다른 수집의 결과는 섞지 않습니다.

## 밴쿠버와 캐나다 원격 공고

| 레퍼런스 | 확인한 내용 | 반영 |
| --- | --- | --- |
| [Asana 채용](https://asana.com/jobs) · [Vancouver 오피스](https://asana.com/jobs/vancouver) · [공개 Greenhouse API](https://boards-api.greenhouse.io/v1/boards/asana/jobs?content=true&pay_transparency=true) | 실제 공고별 근무지와 밴쿠버 채용, 직무 본문의 오피스 근무 일정 | Asana 공개 게시판을 추가하고, 해당 직무가 특정 오피스에서 하이브리드 일정으로 일한다는 명시적 문장을 판별 |
| [Asana Senior Analytics Engineer](https://asana.com/jobs/apply/8075917?gh_jid=8075917) | 밴쿠버 근무, 직무별 하이브리드 문장, CAD 106,000–120,000와 연간 지급 명시 | 원문 근거와 통화·기간을 보존하며, 기간이 없는 다른 공고의 금액까지 연봉으로 추정하지 않음 |
| [Jane 채용](https://jane.app/careers) · [공식 페이지에서 연결한 Ashby 게시판](https://jobs.ashbyhq.com/jane) · [공개 API](https://api.ashbyhq.com/posting-api/job-board/jane?includeCompensation=true) | 캐나다·미국의 원격 회사이며 개별 공고마다 근무 가능한 국가가 다름 | Jane 공개 게시판을 추가하고, 회사 주소를 도시 근무지로 사용하지 않으며 공고에 명시된 원격 국가 범위 유지 |

2026-09-19 공식 페이지와 공개 API를 대조했습니다. 회사의 오피스 소개는 채용 출처를 확인하는 자료이며, 각 공고의 위치·근무 형태·원격근무 자격을 대신하지 않습니다. 회사 전체의 정책·가능성 표현·서로 충돌하는 본문은 직무의 확정된 근무 형태로 바꾸지 않습니다.

같은 날 SmartRecruiters의 [Endpoints](https://developers.smartrecruiters.com/docs/endpoints)·[객체 설명](https://developers.smartrecruiters.com/docs/objects)과 상세 응답의 HTTP 재검증도 확인했습니다. `releasedDate`는 게시 날짜로 설명되어 있어 본문·활성 상태의 버전으로 취급하지 않았습니다. 확인한 상세 4건은 `ETag`가 있었지만 `If-None-Match` 요청에도 `200`으로 응답했고, 동일한 요청 헤더로 다시 확인한 Canva 공고도 같은 태그·본문의 `200`이었습니다. 이번 관측만으로 API 전체의 동작을 단정하지 않으며, 상세 조회를 생략하는 변경은 적용하지 않았습니다.

## 국가별 보상 행과 이전 기록의 재해석

| 레퍼런스 | 확인한 내용 | 반영 |
| --- | --- | --- |
| [Ashby Job Postings API](https://developers.ashbyhq.com/docs/public-job-posting-api) | `includeCompensation=true`로 구조화된 보상을 요청할 수 있으며 본문도 별도 필드로 제공 | 구조화된 구간을 우선하고 값이 없는 공고의 본문을 확인 |
| [Jane Staff Analytics Engineer](https://jobs.ashbyhq.com/jane/aad68bb2-49b3-4d45-b08d-aab8076cd5c3) · [공개 응답](https://api.ashbyhq.com/posting-api/job-board/jane?includeCompensation=true) | 보상 배열은 비어 있고, 급여 설명 뒤에 캐나다·미국 구간과 괄호 안의 경력 단계별 예시 금액을 나열 | 보상 문맥 안의 지역별 행을 읽고 해당 지역·통화·전체 구간과 원문을 보존 |

2026-09-19 문서·실제 공고·API 응답을 확인했습니다. 해당 공고는 캐나다 CAD 152,000–237,500, 미국 USD 149,600–215,100을 표시하지만 지급 기간은 명시하지 않습니다. 다른 공고의 연간 지급 문구나 나라 이름으로 기간·통화를 채우지 않습니다. 예시 금액은 원문 안에 남기고 별도의 확정 급여로 추가하지 않습니다.

보상 문맥은 근처의 제목·설명과 이어지는 지역별 행 안에서만 사용합니다. 다른 섹션·복지 예산·보너스 설명을 만나면 상속을 멈추고, 급여 검토 주기를 급여의 지급 기간으로 사용하지 않습니다. 기존 캐시·저장 공고를 다시 읽을 때는 구조화된 보상과 따로 보관한 원문 근거를 유지하며, 재해석을 새 조회로 표시하지 않습니다.

## 브라우저 저장 용량과 기록별 저장

| 레퍼런스 | 확인한 내용 | 반영 |
| --- | --- | --- |
| [MDN: Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) | localStorage의 용량 한도·QuotaExceededError, 브라우저별 IndexedDB 용량과 best-effort 보관 | 큰 공고 스냅샷은 IndexedDB에 저장하고, 공간 부족과 데이터 보관의 제한을 표시 |
| [MDN: Using IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB) | 비동기 요청·오브젝트 스토어·트랜잭션, 여러 탭에서 열린 데이터베이스의 변경 처리 | 공고별 읽기·쓰기, 한 트랜잭션으로 이전, 버전 변경 시 연결 종료 |
| [MDN: IDBTransaction complete](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/complete_event) | complete는 트랜잭션이 성공적으로 커밋된 뒤 발생 | put 요청이 성공해도 이후 트랜잭션이 중단되면 저장 완료로 표시하지 않음 |
| [MDN: beforeunload](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event) | 저장하지 않은 입력이 있을 때 이탈 안내에 사용할 수 있지만 특히 모바일에서 항상 실행되지 않음 | 대기 중인 변경이 있을 때만 등록하고, 실제 보관은 저장 완료 표시와 CSV로 확인 |

2026-09-19 원문을 확인했습니다. 실제 보관 공고 1,322개 중 본문이 긴 500개의 저장 문자열은 이 환경의 localStorage 한도를 넘었고, 같은 자료를 IndexedDB에 기록한 뒤 앱에서 다시 읽는 것을 확인했습니다. 모든 500개 조합이 같은 크기이거나 IndexedDB 용량이 무제한이라는 뜻은 아닙니다. [저장소 동작과 제한](saved-storage.md)에 이전 원본의 보관 범위, 실패 후 재시도, 여러 탭의 동시 수정 규칙을 정리했습니다.

## 저장 기록의 파일 백업과 원본 정리

| 레퍼런스 | 확인한 내용 | 반영 |
| --- | --- | --- |
| [MDN: Using files from web applications](https://developer.mozilla.org/en-US/docs/Web/API/File_API/Using_files_from_web_applications) | 사용자가 선택한 File의 이름·바이트 크기와 객체 URL의 생성·해제 | 파일 크기를 읽기 전에 확인하고 브라우저 안에서 JSON을 해석하며 다운로드 뒤 객체 URL 해제 |
| [MDN: accept](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/accept) | 파일 선택기의 accept는 형식 검증이 아닌 안내 | 확장자·MIME만으로 판단하지 않고 JSON·버전·공고 스키마·수량을 검증 |
| [WHATWG HTML: Web storage](https://html.spec.whatwg.org/multipage/webstorage.html) | 다중 프로세스의 agent cluster 사이에는 잠금이 없다고 가정해야 함 | 이전 localStorage 사본 삭제에 원자적인 비교·삭제를 보장하지 않으며 이전 버전의 다른 탭을 닫도록 안내 |

2026-09-19 원문을 확인했습니다. 파일은 업로드하지 않고 브라우저에서 검토·저장합니다. 선택한 공고의 현재 값 비교와 한도 확인·일괄 반영은 IndexedDB의 한 트랜잭션 안에서 수행합니다. 원본 정리는 보관 위치별로 범위를 나누며, 이전 완료 표시와 현재 정상 기록을 유지합니다. [파일 형식·충돌·삭제 범위](saved-storage.md)에 구체적인 계약을 정리했습니다.

## 회사에 공고가 많을 때의 페이지 탐색

| 레퍼런스 | 확인한 내용 | 반영 |
| --- | --- | --- |
| [GOV.UK Design System: Pagination](https://design-system.service.gov.uk/components/pagination/) | 모든 내용을 한 화면에 표시하는 것이 사용성·성능에 불리할 때 페이지 구분을 고려하고, 키보드 사용에 문제가 되는 자동 무한 스크롤을 피함 | 실제 138개 공고가 펼쳐지는 회사에서 문제를 확인하고, 10개씩 직접 이동하는 페이지와 현재 범위를 표시 |
| [WAI-ARIA APG: Disclosure](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/) | 네이티브 버튼의 Enter·Space 조작, aria-expanded와 대상 영역의 관계 | 회사 공고 펼치기·접기의 상태와 제어 대상을 연결 |
| [WCAG 2.2: Focus Order](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html) | 동적으로 내용이 달라져도 의미와 조작 순서를 유지하는 포커스 | 페이지 이동 후 첫 공고, 접기 후 펼치기 버튼으로 포커스를 이동하고 모바일 화면 안에 표시 |
| [React: Adjusting some state when a prop changes](https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes) | 입력 변경 시 상태 일부를 조정하는 조건부 렌더링과 부수 효과의 분리 | 공고 ID·정렬 순서가 바뀌면 페이지를 초기화하고, 실제 포커스·스크롤은 사용자 동작 후 처리 |

2026-09-20 원문을 확인했습니다. 페이지당 10개는 이 앱의 회사 카드 크기와 탐색 흐름에 맞춘 선택이며 레퍼런스가 지정한 수치가 아닙니다. 검색·추천·집계는 전체 후보로 계산하고 페이지 선택은 브라우저에서 처리합니다. 데스크톱에서는 회사 목록의 스크롤 영역만 이동하고, 모바일에서는 문서를 이동해 선택한 공고를 보여줍니다.

## 개발자 대상 글쓰기와 개발 직무

| 레퍼런스 | 확인한 내용 | 반영 |
| --- | --- | --- |
| [Anthropic: Copywriter, Developer](https://job-boards.greenhouse.io/anthropic/jobs/5423931008) · [공개 공고 API](https://boards-api.greenhouse.io/v1/boards/anthropic/jobs/5423931008) | 개발자 대상 브랜드 캠페인·문체 지침·행사 및 광고 문구를 작성하는 역할 | 쉼표 뒤의 Developer를 직업으로 읽지 않고 명시적인 Copywriter 역할과 원래 제목을 보존 |
| [Mistral: Senior Technical Writer / Developer Educator](https://jobs.ashbyhq.com/mistral.ai/81f093c9-d49d-4353-85da-c758cd1f383f) | API·SDK·튜토리얼·배포 문서의 품질과 문체를 담당하는 기술 문서 작성 역할 | Engineering 부서와 개발 경험 요구만으로 개발 직군으로 바꾸지 않음 |
| [O*NET: Writers and Authors, 27-3043.00](https://www.onetonline.org/link/summary/27-3043.00) | 광고 등을 포함한 글 작성, Copywriter·Content Marketing Writer 등의 직함 | 개발자가 대상 독자인 글쓰기 직무와 엔지니어 직무의 구분 |
| [O*NET: Technical Writers, 27-3042.00](https://www.onetonline.org/link/summary/27-3042.00) | 기술 자료·설명서·운영 지침 작성, Engineering Writer·Technical Writer 등의 직함 | Engineering이라는 단어가 포함된 기술 문서 작성 직함의 해석 |

2026-09-20 두 공고의 공식 페이지와 O*NET 설명을 확인했습니다. Anthropic은 단일 공고 API도 대조했고, Mistral은 공식 페이지에 포함된 본문과 이전에 보관한 공개 공고 본문을 확인했습니다. 전체 게시판을 새로 수집한 결과는 아닙니다.

제목에서 명시적인 글쓰기 역할을 먼저 구분하되 주된 직함에 엔지니어·소프트웨어 개발자·연구원 역할이 함께 명시된 경우와 공개 관리자 정보를 유지합니다. 마케팅 부서나 Developer Relations 전체를 제외하는 규칙은 아닙니다. O*NET은 업무 의미를 확인하는 참고 자료이며 직업 코드를 자동 부여하거나 분류 정확도를 보증하는 근거로 사용하지 않습니다. 원래 공고 제목과 부서 표기는 저장·상세 근거에서 계속 확인할 수 있습니다.

## 저장한 공고의 직군과 설명 일치

| 레퍼런스 | 확인한 원칙 | 반영 |
| --- | --- | --- |
| [NN/g: Consistency and Standards](https://www.nngroup.com/articles/consistency-and-standards/) | 같은 개념의 의미를 화면마다 다시 해석하지 않도록 일관성을 유지 | 현재 직군과 적용할 세부 직무를 공통 함수로 읽고 저장 검색·상세·CSV에 같은 기준 사용 |
| [NN/g: Match Between the System and the Real World](https://www.nngroup.com/articles/match-system-real-world/) | 내부 시스템 용어보다 사용자가 이해하는 말과 업무의 자연스러운 순서 사용 | 범위 밖 공고에 ‘인프라·DevOps’ 같은 잘못된 전문 분야를 표시하지 않고 현재 직군·실제 제목·공개 부서를 안내 |
| [Microsoft HAX: Guideline 11](https://www.microsoft.com/en-us/haxtoolkit/guideline/make-clear-why-the-system-did-what-it-did/) | 결과의 이유에 접근할 수 있게 하되 설명 자체가 과도한 신뢰를 만들 수 있음을 고려 | 직군의 원문 근거를 제공하고 기술·경력 조건 비교를 희망 개발 직무 일치와 구분 |

2026-09-20 원문을 확인했습니다. HAX는 AI 시스템에 대한 지침이며, 여기서는 규칙 기반 분류·조건 비교의 설명을 검토하는 데 참고했습니다.

현재 직군에 적용하지 않는 이전 세부 분류는 원본 스냅샷과 JSON 백업에 보존합니다. 화면과 CSV의 분류 근거에는 현재 적용하는 정보만 사용하고, 상세에서 공고의 제목과 공개 부서를 확인할 수 있게 했습니다. 입력 기술·경력과 일치하는 실제 조건은 계속 보여주되 범위 밖 공고에 개발 직무 가산점이나 희망 직무 일치를 부여하지 않습니다.

## 현재 근무지와 공고의 게시 위치

| 레퍼런스 | 확인한 내용 | 반영 |
| --- | --- | --- |
| [Google: JobPosting의 jobLocation](https://developers.google.com/search/docs/appearance/structured-data/job-posting?hl=en) | 직원이 실제로 출근할 장소를 사용하며 공고를 게시한 위치와 구분. 복수 근무지와 원격근무의 지역 조건도 별도로 설명 | 현재 근무지·지원자 거주지·향후 전환 장소를 구분하고 실제 업무 장소를 지도에 연결 |
| [Ashby: Public Job Posting API](https://developers.ashbyhq.com/docs/public-job-posting-api) | `location`, `secondaryLocations`, 주소, `workplaceType`, 공개 본문을 제공하며 원천의 누락 값도 누락 상태로 반환 | 게시 위치를 보존하면서 해당 직무의 명시적인 본문과 제목을 대조 |
| [Mistral: Applied Scientist, Internship in Paris or London](https://jobs.ashbyhq.com/mistral.ai/60ab6a5e-9b02-4ae7-a0fb-4c7d9ec0fdf8) | 게시 위치는 Seoul. 본문은 Paris/London에서 6개월 인턴십, 한국 거주 지원자, 이후 조건부 Seoul 정규직 전환을 각각 명시 | 현재 인턴십은 Paris/London에 표시하고 전체 조건 문단과 원래 Seoul 표기를 함께 보존 |
| [Canva: Sydney 이전 프런트엔드 공고, New York 게시](https://api.smartrecruiters.com/v1/companies/Canva/postings/6000000001257703) · [San Francisco 게시](https://api.smartrecruiters.com/v1/companies/Canva/postings/6000000001240659) | 제목은 `RELOCATE to Sydney`, 직무 본문도 Sydney 근무를 명시하지만 두 게시 ID의 등록 위치는 미국 | 서로 다른 공개 ID를 유지하며 두 공고를 Sydney에 연결 |
| [Canva: Security Engineer, Investigations](https://api.smartrecruiters.com/v1/companies/Canva/postings/6000000001275038) · [Developer Tooling Engineer](https://api.smartrecruiters.com/v1/companies/Canva/postings/6000000001389069) | Sydney/Melbourne 게시 위치와 본문의 Melbourne/Sydney 근무지가 각각 충돌하며 제목에서 이전 목적지를 확인할 수 없음 | 어느 쪽이 정확하다고 단정하지 않고 기타 근무지에 보관하며 두 위치와 근거를 표시 |

2026-09-20 Google·Ashby 문서, Mistral의 공식 페이지·공개 API, Canva의 네 공고 상세 API를 확인했습니다. 이 문서들이 자동 위치 판별의 정확도를 보증하는 것은 아닙니다.

명시적인 영어 직무 문장과 제공 도시 이름을 확인하는 제한된 규칙입니다. 근무 문장 전체의 도시 목록을 확인할 수 없는 경우, 일부 도시가 겹치는 복수 위치, 원격근무의 지역 조건은 기존 처리를 유지합니다. 회사 소개·담당자 위치·출장·지원자 거주지·조건부 이후 근무지를 현재 직무의 위치로 추론하지 않습니다. 해석에 사용한 제목·문단은 표시 본문의 길이 제한과 별도로 보관하고, 캐시·저장·검색·게시 내용 비교·백업에서 같은 판단을 사용합니다.

## 비자와 이주 지원, 기존 스폰서십 변경

| 레퍼런스 | 확인한 내용 | 반영 |
| --- | --- | --- |
| [Mistral: Applied Scientist, Internship in Paris or London](https://jobs.ashbyhq.com/mistral.ai/60ab6a5e-9b02-4ae7-a0fb-4c7d9ec0fdf8) · [공개 Ashby API](https://api.ashbyhq.com/posting-api/job-board/mistral.ai?includeCompensation=true) | 6개월 인턴십에 `visa sponsorship and relocation support provided by Mistral`을 명시. 같은 문단에 한국 거주와 이후 서울 채용 단계의 조건도 포함 | 비자와 이주 지원이 함께 쓰인 제공 문구를 읽고 현재 인턴십의 지원·기간·이후 조건을 보존 |
| [Wise: Global KYC and Onboarding](https://api.smartrecruiters.com/v1/companies/Wise/postings/744000150420919) · [Payin Platform](https://api.smartrecruiters.com/v1/companies/Wise/postings/744000150045299) | 현지 지원자만 고려하며 이주 지원은 제공하지 않고 `support transfer of visa sponsorship`을 명시 | 기존 스폰서십 변경에 한정된 조건부 지원으로 표시하고 적용 조건 문단을 함께 제공 |
| [Wise: Reliability](https://api.smartrecruiters.com/v1/companies/Wise/postings/744000149726079) · [Wise Platform](https://api.smartrecruiters.com/v1/companies/Wise/postings/744000149653173) | 런던 공고의 현지 지원자에 대한 같은 스폰서십 변경 지원 문구 | 목록·상세·저장 기록에 지원 유형을 안내하고 조건부 지원 필터에 포함 |
| [GOV.UK: Update your Skilled Worker visa if you change job or employer](https://www.gov.uk/skilled-worker-visa/update-your-visa-if-you-change-job-or-employer) | 적용 대상자의 고용주 변경에는 비자 갱신 신청, 새 직무의 자격 요건과 새 후원 증명서가 필요하며 새 허가를 확인하기 전에 새 직무를 시작하지 않도록 안내 | 고용주의 스폰서십 변경 지원을 새 비자 발급·취업 허가 보장으로 해석하지 않음 |

2026-09-20 Mistral의 공개 게시판과 Wise의 네 상세 API, GOV.UK 안내 원문을 확인했습니다. 다섯 공고는 정상 응답의 공개·활성 공고였고, 보관된 공고와 새 응답의 비자 지원·원문 근거·취업 자격 해석이 일치했습니다. GOV.UK 안내는 지원과 허가의 차이를 확인하는 참고 자료이며, Wise 공고의 비자 종류나 지원자의 신청 자격을 자동으로 판단하는 규칙으로 사용하지 않습니다.

명시적인 영어 문구를 다루며 질문·업무 경험·과거 제공 이력·가능성 표현·카드 네트워크의 Visa를 지원 약속으로 바꾸지 않습니다. 이주 지원의 부정, 스폰서십 변경만의 부정, 전체 비자 지원의 부정을 구분하고, 상충하는 근거는 원문과 함께 미확인으로 남깁니다. 이후 별도 채용 단계에만 적용되는 지원을 현재 인턴십에 확대하지 않습니다. 전체 문단은 기간·현지 지원자·거주 및 이후 취업 조건을 함께 확인할 수 있도록 보존합니다.

## 모바일 목록의 터치 영역과 포커스

| 레퍼런스 | 확인한 내용 | 반영 |
| --- | --- | --- |
| [W3C: Target Size, Minimum · 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) | AA 기준은 24×24 CSS px이며, 작은 대상에는 간격·동등한 조작 등 예외 조건이 있음 | 다른 도시 열기 버튼 위에 겹친 비교 버튼의 기본 영역을 24px로 확대 |
| [W3C: Target Size, Enhanced · 2.5.5](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html) | 강화 기준은 44×44 CSS px이며, 터치·한 손 조작 등에서 작은 대상을 누르기 어려운 사용자를 지원 | 모바일 도시 비교·공고 저장·페이지 이동·상세 닫기 등 주요 조작에 44px 영역을 선택 |
| [W3C: Focus Not Obscured, Minimum · 2.4.11](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html) | 포커스를 받은 요소가 작성자가 배치한 고정 콘텐츠에 완전히 가려지지 않아야 함. 고정 머리말·바닥글과 스크롤 여백을 예시로 설명 | 하단 메뉴를 고려한 스크롤 여백, 본문을 덮지 않는 모바일 필터 안내, 초기화 후 검색으로 포커스 복귀 |
| [MDN: env()와 safe-area-inset](https://developer.mozilla.org/en-US/docs/Web/CSS/env) | 비직사각형 디스플레이나 표시 영역의 가장자리에서 안전하게 콘텐츠를 놓을 수 있는 여백을 제공 | 하단 안전 영역을 메뉴 높이와 문서·스크롤 여백에 함께 반영 |
| [GOV.UK: Type scale](https://design-system.service.gov.uk/styles/type-scale/) | 글자 크기와 줄 간격을 함께 정의하고 다양한 기기에서 읽기 쉽게 조정. 최신 스케일은 작은 화면의 본문·보조 글자를 크게 유지 | 모바일 공고 제목 16px, 직무·근무·비자 등 목록 설명 12px로 조정하고 실제 긴 제목·조건 문구로 배치 확인 |

2026-09-20 각 원문을 확인했습니다. 24px 최소 기준과 44px 강화 기준을 구분하고, 앱의 핵심 모바일 조작에는 44px를 선택했습니다. 글자 크기는 이 앱의 목록 밀도와 실제 문구를 확인해 정한 값입니다.

화면 안에 있다는 좌표 검사만으로는 하단 메뉴에 가린 버튼을 찾을 수 없었습니다. 실제 키보드 이동 후 요소 위의 여러 지점에서 어떤 요소가 보이는지 함께 확인합니다. Chrome의 안전 영역 에뮬레이션으로 하단 34px 조건도 검증하며, 기기별 검증 범위는 [개선 기록](improvements.md)에 정리합니다.

## 지도 도시와 독립적인 원격근무 국가

| 레퍼런스 | 확인한 내용 | 반영 |
| --- | --- | --- |
| [UN M49](https://unstats.un.org/unsd/methodology/m49/) · [전체 표](https://unstats.un.org/unsd/methodology/m49/overview/) | 국가·지역별 이름, ISO alpha-2·alpha-3, 통계용 지리 구분. 지역 구분은 정치적 소속이나 고용 범위를 뜻하지 않음 | 국가 식별표를 지도 도시와 분리. 기존 지역 탭은 미주·유럽·아시아 및 오세아니아의 지리 구분을 사용 |
| [Unicode CLDR 코드 대응](https://github.com/unicode-org/cldr/blob/7b1090ada749eb29d85d64bfb6c1952671d4b1f5/common/supplemental/supplementalData.xml) | `TW`·`TWN`, 사용자 할당 `XK`·`XKK` 대응 | M49의 248개 항목과 함께 국가·지역 250개를 제공. 추가 별칭 `XKX`도 같은 항목으로 처리 |
| [MDN: Intl.DisplayNames](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DisplayNames) | 언어·지역·문자 체계의 표시 이름을 실행 환경에서 제공 | 한국어 국가 선택과 공고 상세·검색·CSV의 국가 이름을 공유 |
| [Ashby Public Job Posting API](https://developers.ashbyhq.com/docs/public-job-posting-api) | 공고 위치, 추가 위치와 국가 주소를 별도 필드로 제공 | 국가 필드의 코드를 읽고, 공고에 표시된 코드와 주소가 일치할 때 주 약어와 구분. 광역 지역이나 사무실 주소를 근무 허용 국가로 확장하지 않음 |

2026-09-20 각 원문과 GitLab·Airbnb·Datadog·Canva·n8n의 공개 API 응답을 확인했습니다. 폴란드·뉴질랜드·브라질·이탈리아·이스라엘이 위치에 명시돼도 기존 16개 국가 목록 밖이라 누락되는 문제가 있었습니다.

실제 자료에는 호주의 `SA`, 미국의 `New Jersey`, n8n의 `Georgia`도 함께 있었습니다. 마지막 항목의 주소는 `United States`였습니다. 자유 형식의 두 글자 약어와 동명 지역을 국가로 단정하지 않고, 명시적인 국가 필드로 확인 가능한 경우를 구분합니다. `Europe`·`EMEA`·`APAC`·`AMER`를 국가 목록으로 펼치지 않으며, 거주 국가 일치는 국적·취업 허가·주별 제한·협업 시간대의 충족을 뜻하지 않습니다.

정적 국가 표의 기준일과 코드 출처는 [출처 고지](attributions.md)에 기록했습니다. 국가 파싱 규칙을 바꿀 때는 `REMOTE_SCOPE_VERSION`과 이전 캐시·저장 기록의 재해석도 함께 검토합니다.

## 개인 경력의 미입력과 소수 연수

| 레퍼런스 | 확인한 내용 | 반영 |
| --- | --- | --- |
| [MDN: number 입력](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/number) | 선택 입력의 빈 값은 유효하며, 기본 `step=1`은 소수 입력과 맞지 않을 수 있음. 입력 범위와 숫자 형식을 별도로 확인 | 빈 값과 0을 구분하고 소수 입력 허용. 0~50년 범위를 확인하며 자동 반올림·범위 보정 제거 |
| [WCAG 2.2: Labels or Instructions, 3.3.2](https://www.w3.org/WAI/WCAG22/Understanding/labels-or-instructions.html) | 선택 입력을 포함해 필요한 정보와 기대하는 입력 형식 안내 | 경력 입력 옆에 선택 사항·허용 범위·소수 예시·비워 둘 때의 동작 안내 |
| [WCAG 2.2: Error Identification, 3.3.1](https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html) | 오류가 난 항목과 오류 내용을 텍스트로 식별 | 해당 경력 입력으로 포커스 이동, `aria-invalid`와 연결된 오류 설명 제공. 작성 중인 값 유지 |

2026-09-20 각 원문을 확인했습니다. 경력 정보가 없을 때 기본값 3년을 넣고, `3.5 years of experience`를 5년으로 읽던 동작은 앱의 실제 분석 함수와 보관된 공개 공고로 재현했습니다.

미입력 경력의 점수를 제외하고 경력 충족 여부를 설명하지 않는 것은 이 앱의 추천 설계입니다. 위 표준이 특정 추출 규칙이나 추천 가중치를 보장한다는 의미는 아닙니다. 한국어·영어의 명시적 기간을 읽는 기능이며, 전체 경력과 기술별 경력의 중복·경력 공백을 자동 계산하지 않습니다.
