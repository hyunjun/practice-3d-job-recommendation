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
