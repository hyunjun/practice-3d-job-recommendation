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
- 지도에 없다고 채용 기회가 없다는 인상을 주지 않도록 22개 도시·대상 회사·조회 상태를 표시합니다.
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
