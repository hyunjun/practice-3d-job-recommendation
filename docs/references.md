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
| [Greenhouse Job Board API](https://developers.greenhouse.io/job-board.html) | 공개 GET 조회, 공고별 `metadata`·`offices`, `pay_input_ranges.currency_type` | 실제 근무지와 조건의 원문 근거, 기존 10개 회사 수집 |
| [Ashby Public Job Posting API](https://developers.ashbyhq.com/docs/public-job-posting-api) | `isListed`, `workplaceType`, `employmentType`, `secondaryLocations`, `includeCompensation=true`와 보상 구간 | 목록 비공개 공고 제외, 추가 근무지와 국가 주소, 기본 급여·통화·기간 보존, 5개 회사 수집 |
| [Lever Postings API](https://github.com/lever/postings-api) | 공개 공고 배열, `limit`·`skip`, `allLocations`, `commitment`, `salaryRange.interval`, EU 주소 | 전체 페이지 성공 후 반영, 계약 기간과 근무 시간 구분, 2개 회사 수집 |
| [MDN Retry-After](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After) | 초 단위와 HTTP 날짜 형식 | 게시판별 재조회 대기 시각 |
| [RFC 5861 §4](https://www.rfc-editor.org/rfc/rfc5861.html#section-4) | 오류 시 제한된 기간 동안 이전 정상 결과 사용 | 원래 조회 시각 보존, 24시간 이후 추천 제외 |

실제 응답과 함께 검증했습니다. API 문서의 선택 필드는 누락될 수 있고, 공개 게시판은 회사가 다른 서비스로 옮기면 바뀔 수 있습니다. 조사 시 Mistral AI의 기존 Lever 게시판은 빈 목록이었으며, [공식 채용 페이지](https://mistral.ai/careers)가 연결한 Ashby의 `mistral.ai` 게시판을 사용합니다. 응답 구조와 조회 상태를 검증하고, 해석하지 못한 지원 국가나 보상 조건을 임의로 채우지 않습니다. 적용 결과와 검증 시점은 [개선 기록](improvements.md)에 남깁니다.
