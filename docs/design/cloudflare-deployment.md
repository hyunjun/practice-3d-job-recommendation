# Cloudflare 배포 설계 · 82단계 · 공동안 v7

이 문서 전체의 해시에 대한 주 구현 담당·GPT-6 Astra Max의 명시적 설계 승인이 있어야 제품과 테스트를 작성한다. 2026-10-05 사용자의 “fable 검토는 제외하고 이전 goal 진행해줘” 지시에 따라 Fable 참여·승인 의무를 해제하고 별도 테스트 전담 subagent가 독립 검증한다. 과거 미완료 Fable 검토는 완료로 바꾸지 않는다. 실제 단계별 승인과 해시는 검증 기록에 남기며, 설계 승인·구현 승인·검증 완료는 별개다.

## 목적과 범위

사용자가 승인한 조건은 `https://job.hyunjun.workers.dev`, 마지막 검증 완료 커밋 `d96367ba9e06ad32737250a482c662e11b7881be` 우선 배포, 무료 범위 우선, 예약 수집이다. 별도 `deploy/cloudflare-workers` worktree에서 작업하며, 미완료 81단계 변경은 포함하지 않는다. 사용자 확인용 로컬 서버는 종료 상태로 유지한다.

프런트엔드와 조회 API를 Cloudflare Workers에 배포한다. 수집·정규화·본문 해시 계산은 공개 GitHub 저장소의 일반 Ubuntu 실행기에서 수행한다. 수집 결과는 하나의 SQLite 기반 Durable Object에 보관한다. R2, Containers, KV, 유료 실행기, 유료 플랜을 활성화하지 않는다. 무료 한도를 넘으면 실패를 드러내며 자동 결제 전환이나 데이터 생략으로 회피하지 않는다.

## 독립 의견과 선택 근거

- Main의 첫 안은 KV의 압축된 파일과 작은 Durable Object의 커밋 포인터를 결합했다. API가 발행 시점의 상태만 반환하는 제한과 여러 조회가 서로 다른 이전 버전을 선택할 위험이 있었다.
- Astra는 공개 데이터와 수집 상태를 하나의 Durable Object에 함께 보관하고, 회사별 시간 경계를 요청 시점에 적용하는 방식을 제안했다.
- Fable은 KV의 변경 불가능한 파일과 마지막 포인터 교체를 제안했다. KV는 작성한 위치에서도 읽기가 지연될 수 있으므로 포인터의 마지막 쓰기만으로 여러 파일의 원자성을 보장할 수 없다.

공동안은 **Astra의 단일 Durable Object 방식을 채택**한다. 큰 JSON을 Worker 메모리에 올리는 대신 Node에서 회사별 응답 조각을 미리 만들고 압축한다. 여러 조각을 1 MiB 단위 저장 청크에 함께 넣어 작은 회사마다 SQLite 행을 늘리지 않는다. 요청 시각에 맞는 조각을 순서대로 풀어 스트리밍한다. 조회는 수집을 시작하지 않는다.

Fable의 초기 제안에서 다음은 수정한다. 인코딩이 다른 응답은 약한 ETag를 공유한다. 예약 실행이 지연·누락될 수 있으므로 `publishedAt + 30분`을 확정된 수집 시각이나 원래 `refreshAfter`로 쓰지 않는다. 발행 성공을 모든 회사의 최신 수집 성공으로 간주하지 않는다. 장애 시 오래된 상태가 한 주기 안에 반드시 해소된다고 보장하지 않는다. 사용자 배포 요청은 통상적인 설정·배포 작업의 권한을 이미 포함한다.

## 실행과 저장 구조

1. Workers Static Assets가 `dist-cloudflare/`의 Vite 빌드를 제공한다. 기존 Express용 `dist/`는 별도로 유지한다. `run_worker_first`는 `["/api", "/api/*", "/__orbit/publish", "/__orbit/publish/*"]`이다. 정확한 루트 또는 `/` 경계로만 분기하며 `/api`도 JSON 404를, 비공개 루트도 인증 후 JSON 오류를 반환한다. 다른 경로에는 SPA fallback을 적용하되, API 오류를 HTML로 바꾸지 않는다.
2. Worker는 공개 API 경로·메서드를 확인한 뒤 이름이 고정된 하나의 `CatalogStore` Durable Object로 전달한다. 큰 본문 파싱·압축·provider 호출을 하지 않는다.
3. Durable Object는 현재 커밋, 이전 커밋, 발행 중 manifest, 압축 청크를 SQLite에 저장한다. 공개 조회와 비공개 수집 체크포인트가 **하나의 커밋**에 묶인다.
4. 예약 수집기는 현재 커밋과 그 체크포인트를 인증된 경로로 받는다. 체크포인트의 해시·크기·스키마·구성 ID를 검증하고 임시 디렉터리에서 복원한다. 기존 자료를 읽지 못하면 빈 상태로 다시 시작하지 않고 실패한다. 현재 커밋이 없는 최초 실행만 빈 상태에서 시작한다.
5. 수집기는 별도의 전용 service 인스턴스에서 목록 pass → 본문 pass 순서로 실행한다. 각각 실행당 최대 한 번, `force=false`이며 회사별 due/backoff·호출 간격·동시성 정책을 그대로 적용한다. pass는 내부적으로 여러 provider 요청을 할 수 있고, due가 아닌 회사는 건너뛴다. 결과와 관측 저장이 모두 끝난 뒤 더 이상 수집을 시작하지 않는 export 메서드로 같은 상태를 캡처한다. 최초 운영 측정에 목록/본문별·provider별 요청 수를 포함한다.
6. Node가 공개 스키마를 검사하고 응답 조각, 체크포인트, 청크와 manifest를 만든다. 업로드를 마친 뒤 Durable Object가 모든 청크와 예상 부모 커밋을 확인하고 짧은 `transactionSync`로 공개·비공개 포인터를 함께 교체한다. 수집이나 네트워크 대기를 이 트랜잭션 안에 넣지 않는다.

`server/catalog-service.ts`의 기존 조회 메서드 기본 동작은 유지한다. 새로운 전용 캡처 메서드는 목록→본문 정책을 지키고, 완료 후 여러 public getter를 호출해 두 번째 수집을 시작하지 않는다. `compose` 계열에는 캡처 시각을 전달할 수 있게 하되 기존 호출은 기존 `now()`를 사용한다. 전용 인스턴스에서는 캡처 중 다른 외부 조회를 허용하지 않는다.

캡처에는 회사·도시, 공개 catalog와 posting-status, 회사별 원래 unmapped 집계, 모든 board/presence 캐시 상태, 전체 관측 파일이 포함된다. 공개 스키마와 비공개 체크포인트가 다른 순간을 가리키지 않게 한다. 저장 오류는 발행 실패로 전달한다. 수집 실패·backoff·이전 정상 snapshot도 체크포인트에 보존한다. 전부 실패한 최초 실행도 실패 상태와 관측을 원자적으로 보존할 수 있지만 공개 catalog는 503이며 배포 완료 조건은 충족하지 못한다.

구성 ID는 회사/provider/board/region의 정렬된 값과 명시적인 체크포인트 형식 버전으로 계산한다. 실행기의 절대 경로나 임시 폴더 이름을 ID로 쓰지 않는다. 복원할 체크포인트에 당시 회사 목록을 포함하고 그 목록으로 ID를 재계산해 검증한다. 검증된 새 수집 코드의 회사 구성이 달라진 정상 전환은 손상과 구분한다. 동일한 회사/provider/board/region만 재사용하고 신규 회사는 기존 정책으로 수집하며, 이전 관측 묶음은 보존한다. 파일 내부의 ID 불일치·알 수 없는 형식은 빈 상태로 바꾸지 않는다. 관측의 기존 scope/method와 90일·최대 네 묶음 보존 규칙은 유지한다. 초기 배포의 관측은 최초 운영 수집부터 시작한다. 기존 보호 대상 로컬 관측을 새로 수집한 기록으로 가져오지 않는다.

## 발행 형식과 원자성

형식 버전은 `1`이다. manifest에는 UUID generation, 예상 부모 revision/generation, 수집·캡처 시각, 구성 ID, 당시 회사 목록, 수집 코드 커밋, 조각별 압축 위치·압축/해제 크기·해시, 청크별 해시·크기, 아래 응답 선택에 필요한 작은 메타데이터가 있다. 발행 시각 `publishedAt`은 실제 커밋 때 서버 UTC 시각으로 기록하며, 원본의 조회/성공/실패 시각과 구분한다.

- 각 조각은 Node가 만든 **독립적인 gzip 스트림**이다. `JSON.stringify`로 인코딩한 완전한 값이나 배열 내부 원소열을 사용한다. 구분자는 응답 조립기가 넣는다. 임의 문자열 치환으로 `stale`을 바꾸지 않는다.
- 압축 조각들을 하나의 연속 바이트 공간에 넣고 최대 1 MiB 청크로 분할한다. 조각의 offset/length가 가리키는 청크 범위만 읽는다. 공개 경로는 임의 offset이나 체크포인트 조각을 조회할 수 없다.
- 업로드는 인증된 begin → chunk PUT → commit이다. 동일 generation/index/hash/size의 반복 업로드와 완료 확인은 멱등이다. 다른 내용, 예상 부모 불일치, 누락·초과 청크, 잘못된 범위·버전·크기·해시는 거부한다. 완료 응답이 유실되면 head와 generation을 확인해 이미 완료된 커밋을 판별한다.
- 동시에 한 개의 발행만 준비한다. 청크 업로드가 끊긴 staging은 15분 동안 접근이 없거나 시작 후 2시간이 지나면 만료된다. 현재 커밋에는 영향을 주지 않는다. 다음 실행은 새 head에서 복원·수집하며 실패한 발행을 성공으로 표시하지 않는다.
- 원래 체크포인트를 덮어쓰지 않는다. 현재·이전 커밋을 유지하고, 다른 완료 버전은 은퇴 후 5분 이상 지났고 활성 스트림이 없을 때 정리한다. 청크를 읽는 요청은 generation을 고정하고 응답 종료·취소·오류 때 사용 중 표시를 해제한다. SQL cursor를 `await` 사이에 보관하지 않는다.
- 공개 응답은 한 generation의 조각만 사용한다. 없는 조각을 다른 generation의 조각으로 대체하지 않는다. 저장 오류는 503 또는 이미 시작한 스트림의 오류로 드러난다.

비공개 체크포인트에는 board/presence/observation의 전체 파일을 논리 이름으로 묶는다. 원래 파일의 제한인 128/64/16 MiB를 각각 적용한다. 복원은 정확한 현재 generation에만 연결하며 이전 체크포인트로 조용히 후퇴하지 않는다. scope 변경 시 관측의 과거 묶음은 기존 정책으로 유지한다. 읽기·저장 오류나 알 수 없는 스키마에서는 보존 후 실패한다.

## 요청 시각에 따른 응답

각 응답의 시각은 요청 시작 시 한 번 정한다. generation을 고정해도 현재 시각을 과거로 고정하지 않는다.

### Catalog

Node는 회사별 공고 배열을 `stale: false`와 `stale: true` 두 조각으로 만든다. 이미 실패하거나 stale인 회사는 다시 fresh가 되지 않는다. 스냅샷이 없거나 캡처 때 이미 만료된 회사의 공고를 이후 응답에서 되살리지 않는다.

일반 출처는 정상 확인 후 30분부터 stale, Himalayas와 자사 사이트 직접 수집은 24시간부터 stale이다. **정확히 24시간은 표시 가능하고, 1ms 뒤부터 제외**한다. 회사별 `dataStatus`, `included`, `total`, 공고의 stale, catalog의 stale·fetchedAt·unmappedCount를 같은 선택으로 계산한다. unmapped 값이 미확인인 회사가 포함되면 null을 유지한다.

정상 사용 가능한 회사가 없으면 이전 snapshot 존재 여부에 따라 `CATALOG_EXPIRED` 또는 `CATALOG_UNAVAILABLE` 503을 반환한다. 이 판단은 ETag 비교보다 먼저 한다. 기존 조회/성공/실패 시각, 메시지, retryAt, refreshAfter를 예약 시각으로 덮어쓰지 않는다. 원본 상태에 값이 없어 기존 compose가 `now()`를 쓰는 fallback은 응답 시작 시각으로 계산하고, 캡처/발행 시각을 실제 수집 시각으로 대신하지 않는다.

### Posting status

목록과 본문은 별도 시계다. Node는 회사별 원래 listing, 본문 신선도가 지난 listing(`jobs: []`), 목록 자체가 24시간을 넘겨 listing을 제거한 상태를 만든다. listing은 목록 나이가 `<= 24시간`일 때 포함한다. 본문 summary는 본문 실패가 없고 `응답 시각 < 본문 정상 시각 + sourceFreshFor`일 때만 포함한다. 경계의 등호에서는 summary를 비운다. 본문 실패, unconfirmed IDs, 원래 content 메타데이터와 source별 validUntil을 유지한다. 본문이 만료되거나 실패한 경우 이전 revision을 최신 본문 확인처럼 반환하지 않는다.

API는 기존 version 2 스키마를 유지한다. 모든 listing이 사라져도 회사의 실패·마지막 성공 기록을 읽을 수 있다. catalog의 공고 만료가 posting-status 메타데이터와 관측 기록까지 삭제하는 이유가 되지 않는다.

### 관측

현재 묶음의 날짜별 조각을 보관하고 요청 시 UTC 90일 cutoff를 적용한다. 다른 묶음 요약도 실제로 남는 날짜에 맞게 firstDay/lastDay를 계산한다. 누락된 날을 0으로 만들거나 발행 시각을 수집 시각으로 바꾸지 않는다. 읽기 자체는 관측을 추가하지 않는다.

### 여러 응답의 관계

catalog/posting-status/observations API는 선택한 자료의 `X-Orbit-Generation` 응답 header와 선택적인 `generation` query를 지원한다. query가 없으면 현재 커밋을 선택한다. 값은 대소문자를 허용하는 UUID v4 형식 `^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`이며 저장·응답에는 소문자를 쓴다. 빈 값이나 중복 query도 잘못된 값이다. 보관 중인 generation은 그 버전의 일관된 데이터를 제공하고, 잘못된 값은 400, 더 이상 없는 버전은 410을 반환한다. health는 항상 현재 상태를 보여주며 generation을 선택하는 경로가 아니다.

catalog에 추가되는 `publication`은 정확히 `{ mode: "scheduled", generation: UUID문자열, publishedAt: UTC ISO문자열, intervalMinutes: 30 }`이다. 네 값만 포함한다. DataDialog의 관측 조회는 표시 중인 catalog generation에 연결한다. generation 변경이나 410 때 이전 관측을 새 catalog의 기록처럼 결합하지 않고 비우고 공고 새로고침을 안내한다. 저장 공고의 상태 조회는 현재 catalog와 결합하는 작업이 아니라 저장된 원본과 최신 목록·본문을 비교하는 별도 흐름이므로 최신 generation을 조회하며, 기존 ID/revision/시각 검사로 비교한다. 서로 다른 임의 HTTP 요청이 같은 순간을 본다고 보장하지 않는다.

새 경계의 JSON 응답 형식은 다음과 같다. 오류는 모두 `Cache-Control: no-store`, JSON Content-Type, 공통 보안 헤더를 갖는다. HEAD는 같은 상태·헤더와 빈 본문이다.

| 조건 | 상태 | JSON 본문 |
| --- | --- | --- |
| 잘못되거나 중복된 generation | 400 | `{ "error": "잘못된 공고 자료 버전입니다.", "code": "CATALOG_BAD_GENERATION" }` |
| 보관하지 않는 generation | 410 | `{ "error": "공고 자료가 갱신됐어요. 공고를 새로고침한 뒤 다시 확인해 주세요.", "code": "CATALOG_GENERATION_GONE" }` |
| 8개 본문 스트림 사용 중 추가 본문 요청 | 503 | `{ "error": "공고 조회 요청이 많아요. 잠시 후 다시 확인해 주세요.", "code": "CATALOG_BUSY", "retryAt": UTC ISO(응답 시각 + 60초) }` |
| `/api` 또는 미지원 API·메서드 | 404 | `{ "error": "존재하지 않는 API입니다." }` |
| 미지원 catalog source | 400 | `{ "error": "지원하지 않는 데이터 소스입니다." }` |
| `/api/catalog/progress` | 404 | `{ "error": "수집 진행 정보를 지원하지 않는 서버입니다." }` |
| 비공개 루트·하위 경로의 인증 누락/실패 | 401 | `{ "error": "발행 인증이 필요합니다.", "code": "PUBLISH_UNAUTHORIZED" }` |
| 인증 후 미지원 비공개 경로·메서드 | 404 | `{ "error": "존재하지 않는 발행 경로입니다.", "code": "PUBLISH_NOT_FOUND" }` |

과부하 응답은 `Retry-After: 60`, `Vary: Accept-Encoding`도 포함한다. catalog/posting-status/observations에 같은 형식을 쓰며, 작은 health 응답·HEAD·304는 본문 스트림 제한에서 제외한다. 비공개 인증은 요청 본문을 읽기 전에 수행한다. 401에는 `WWW-Authenticate: Bearer`를 포함한다. 자료가 없는 상태의 catalog 503과 조회 기간 만료의 catalog 503은 기존 `CATALOG_UNAVAILABLE`/`CATALOG_EXPIRED`와 원래 source 재시도 시각을 사용한다. 과부하를 이 두 오류로 표시하지 않는다.

## HTTP와 UI

- 기존 catalog source 별칭 public/sample/greenhouse를 공개 자료에 연결한다. 잘못된 source는 400, 미지원 API·메서드는 JSON 404이다. GET과 HEAD를 지원한다.
- hosted catalog는 `Prefer: respond-async`에도 완료된 200 또는 오류를 반환한다. progressive endpoint는 미지원 404이다. 로컬 Express의 202·progress 흐름은 유지한다.
- 성공 API는 `private, no-cache, must-revalidate`, 오류는 `no-store`를 사용한다. ETag는 generation/선택한 조각/실제 파생 메타데이터에 따른 **약한 validator**이며 인코딩별로 같은 값을 쓸 수 있다. `If-None-Match` 목록·약한 값·`*`, 304, HEAD를 검증한다. 시간이 흘러 실제 표현이 바뀌거나 만료되면 예전 validator로 304를 주지 않는다.
- Durable Object는 선택한 gzip 조각을 제한된 버퍼로 해제해 JSON을 스트리밍한다. `Accept-Encoding`에 따라 br/gzip/identity를 선택하고 Workers Response의 자동 인코딩을 사용한다. 실제 런타임에서 모든 인코딩의 디코딩 결과가 동일한지 검증한다. gzip 파일을 JSON으로 잘못 전달하거나 이중 압축하지 않는다. `Vary: Accept-Encoding`을 설정한다. HEAD/304는 큰 조각을 읽지 않는다.
- Static Assets(`_headers`)와 Worker/DO 코드 응답 모두에 기존 `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`를 유지하고 `X-Frame-Options: DENY`를 추가한다. 기본 재검증 정책을 쓰되 해시가 있는 `/assets/*`만 장기 immutable로 제공한다. 여러 규칙의 Cache-Control 값이 쉼표로 합쳐지지 않게 한다. PDF 보조 파일·폰트·지구 텍스처·catalog worker chunk의 경로와 MIME을 검증한다.
- `VITE_CATALOG_MODE=scheduled`인 Cloudflare 빌드에서만 문구를 바꾼다. 초기 로딩은 “저장된 공개 공고를 불러오고 있어요”로 표시한다. 새로고침은 **최근 발행 자료 다시 읽기**이고 예약 수집을 즉시 실행하지 않는다고 설명한다. 약 30분마다 예약하지만 지연·누락될 수 있고 출처별 수집 간격과 마지막 정상 시각이 기준임을 알린다. 본문 비교 버튼도 예약 자료를 다시 읽는 동작에 맞춘다.
- 기존 검색·지구 조작·비교·프로필·저장·백업 흐름과 로컬 모드 문구는 유지한다. localhost와 workers.dev의 개인 저장 공간은 origin이 다르며 기존 JSON 백업으로 옮길 수 있음을 배포 문서에 명시한다. 프로필·이력서·메모·검색 조건을 발행 서비스에 보내지 않는다.
- 프로젝트 전체의 새 LICENSE는 추가하지 않는다. 기존 자산 고지를 정적 파일로 배포하고, Vite의 번들 의존성 license 출력도 배포물에 포함해 접근 가능한 링크를 제공한다.

## 인증과 한도

32바이트 이상의 무작위 전용 발행 토큰을 Worker secret과 GitHub Actions secret에 넣는다. 비공개 경로는 전체가 인증 대상이며 공개 경로에서 비공개 manifest/체크포인트/임의 청크를 열지 않는다. 토큰을 URL, VITE 변수, 코드, Git, 명령 인수, 공개 결과 또는 로그에 넣지 않는다. 로컬 임시 secret 파일은 0600으로 만들고 사용 후 삭제한다. Cloudflare 계정 OAuth/API 토큰을 수집 실행기에 넘기지 않는다.

Admission 상한은 압축 generation 64 MiB, manifest 512 KiB, 청크당 1 MiB, 큰 본문 스트림 동시 8개, DO 저장 자료 합계 512 MiB이다. 큰 본문 스트림은 공개 세 자료와 인증된 체크포인트 다운로드이며, 작은 health·HEAD·304는 제외한다. Node는 공개 catalog 128 MiB, posting-status 64 MiB, 관측 16 MiB의 해제 크기와 체크포인트 파일별 한도도 검사한다. metadata와 SQL 부가 공간을 별도로 측정하고 DO의 보수적인 1GB 한도 안에 여유를 둔다. 응답별 청크 버퍼는 최대 두 개, 해제 스트림은 한 조각씩 소비한다. 동시 스트림 초과는 위 표의 `CATALOG_BUSY` 503이다.

무료 공식 한도: Worker 100,000 요청/일, 요청당 CPU 10ms, 메모리 128MB. DO의 별도 CPU 제한은 30초이며 무료 SQLite DO는 요청 100,000/일, duration 13,000 GB-s/일, 읽기 5,000,000행/일, 쓰기 100,000행/일, 저장 5GB다. SQLite 한 행의 키+값 제한 2MB보다 작은 청크를 쓴다. Static Assets의 20,000 파일·파일당 25 MiB도 검사한다.

1일 48회, 최대 64개 청크씩 업로드·확인·교체·정리하더라도 행과 인덱스의 실제 비용을 측정해 100,000 쓰기보다 충분히 낮게 유지한다. 이 계산은 다른 앱이 쓰는 계정 공용 한도나 방문량을 보장하지 않는다. 빈번한 실제 조회에서는 행 읽기와 API 요청이 먼저 한도가 될 수 있다. 최초 실제 자료의 압축/해제 크기, SQL 행·바이트, 스트리밍 CPU·동시 요청 결과를 기록한다. 이전 보관 자료의 61,373,688B→gzip 8,176,875B 측정은 참고치이며 실제 배포 측정의 대체가 아니다.

## 예약 작업과 운영

GitHub Actions는 `17,47 * * * *`, `workflow_dispatch`, 일반 `ubuntu-latest`, Node 22, 작업 제한 25분을 사용한다. concurrency group은 고정하고 진행 중 작업을 취소하지 않는다. checkout/setup-node는 확인한 정식 릴리스의 전체 커밋 SHA로 고정한다. 권한은 `contents: read`이다. 공개 저장소의 일반 실행기 시간은 무료다. 큰 자료를 Actions artifact/cache로 올리지 않는다.

수집 코드는 저장소 변수의 검증된 전체 커밋 SHA에서 checkout한다. schedule을 활성화하는 변수는 최초 배포 검증이 끝나기 전에는 false다. 수집 URL과 토큰 외의 계정 권한은 필요 없다. 워크플로는 CLI 종료 코드, 성공/실패, generation과 작은 집계만 남긴다. 임시 체크포인트·발행 파일은 finally/trap으로 정리한다. 예약은 default branch에서 실행되며 지연·누락, 공개 저장소 60일 비활성화 가능성을 문서화한다.

실패하면 이전 커밋을 제공하면서 실제 시각대로 stale/expired 처리한다. `GET /api/health`는 기존 `status: "ok"`, `app: "orbit"`, `mode: "production"`을 유지하고 `delivery: "scheduled"`, `generation: UUID | null`, `publishedAt: UTC ISO | null`, `intervalMinutes: 30`, `boards: 정수`, `usableBoards: 정수`, `ready: boolean`만 추가한다. 최초 커밋 전에는 generation/publishedAt이 null, 두 회사 수는 0, ready는 false다. 커밋 후 boards는 대상 회사 수, usableBoards는 요청 시각에 catalog snapshot을 사용할 수 있는 회사 수이며 ready는 그 수가 0보다 큰지다. 수집 데이터가 없어도 Worker가 응답 가능한 상태이면 status는 "ok"이고 ready로 자료 준비 여부를 구분한다. upstream 오류는 기존 공개 오류 범위로 제한한다. 내부 경로·비밀·원본 체크포인트는 노출하지 않는다.

데이터 rollback은 검증된 이전 공개 generation을 새 단조 증가 커밋으로 다시 선택하는 인증된 명령이다. 공개 원래 시각을 유지한다. **최신 비공개 체크포인트는 보존**하여 관측과 backoff를 되감지 않으며, manifest에 공개 자료와 체크포인트의 출처를 각각 기록한다. 다음 수집은 최신 체크포인트에서 이어간다. 현재/이전/사용 중인 청크를 정리하지 않는다. 코드 rollback은 호환되는 기존 Worker version으로 수행한다. 데이터가 있는 Worker/DO 삭제를 rollback으로 안내하지 않는다. 첫 배포에는 이전 코드 version이 없다는 제한도 기록한다.

## 검증과 완료 조건

별도 테스트 전담 subagent는 테스트와 로컬 검증 자료만 수정한다. Main이 구현과 통합, Astra가 독립 코드 검토를 맡는다. 앱·compiler·build·단위 검사·E2E·브라우저·테스트 서버 실행은 공통 소스·테스트·실행 계획에 대한 Main·Astra 승인 후 테스트 담당이 승인된 실행 제어기를 통해 수행한다. Main은 읽기 전용 조사, 승인된 구현·문서·작업 제어, Git과 배포 운영을 맡는다. 별도 82단계 제어 파일의 변경도 실제 내용 해시에 대해 검토하며 81단계 제어 파일을 바꾸지 않는다.

필수 검사:

1. 기존 전체 타입·단위 검사와 빌드, Cloudflare 빌드·타입 검사·Wrangler dry run. 이 설계는 service/UI도 바꾸므로 기존 83개 파일의 전체 production E2E와 80단계 development 회귀 범위를 실행한다. 소스가 같다는 이유로 이 범위를 줄이지 않는다.
2. Node 발행기와 로컬 Durable Object의 계약 검사: 목록→본문, 캐시/실패/backoff/관측 왕복, 추가 수집 없는 캡처, 전부 실패·일부 실패·일일 출처·미확인 목록·본문 실패, 손상 복원 거부, 구성/method 전환, 크기/수량 상한.
3. 원자 발행·중단·재시도·충돌·유실된 commit 응답·staging 만료·generation 고정·중간 GC·취소·rollback·private 경로 보호. 가상 자료로 실제 SQL/HTTP를 통해 검증한다.
4. 명시적인 시각의 30분·24시간·24시간+1ms, 목록/본문 서로 다른 경계, UTC 90일, ETag 이전/이후·304·HEAD·인코딩·API 오류를 검사한다. 제품 함수로 기대값을 계산해 대신하지 않는다.
5. Workers 로컬 서버 `127.0.0.1:8790`에서 1440/320 폭의 첫 지구 표시, 검색/필터/도시/비교/저장/본문 확인/관측/백업/한국어 PDF import/접근성/정적 자산·콘솔 오류를 검사한다. 기존 테스트의 전용 fixture health guard를 우회하지 않고 별도 config/guard를 둔다.
6. 실제 크기의 가상 자료로 스트리밍, 인코딩, 취소, 8개 동시 요청과 초과 요청, peak memory/행 수/시간을 확인한다. 실제 초기 운영 자료의 크기와 production 요청 CPU도 별도로 측정한다. 메모리나 CPU가 한도를 넘으면 설계 수정 후 재검증하며 성공으로 간주하지 않는다.
7. 배포 후 정확히 `https://job.hyunjun.workers.dev`에 한정한 읽기 전용 smoke와 브라우저 여정을 실행한다. API 요청은 60개 이내, 실제 개인 정보 입력·상태 쓰기·운영 데이터 교체가 없는 검사다. 실패/rollback 시나리오는 로컬 가상 환경에서 검증한다. 운영 관측 로그는 이 공개 smoke 동안 필요한 CPU/outcome 메타데이터만 수집한다.

최초 운영 수집은 130개 회사 구성, 최근 24시간 내 실제 성공 기록이 있는 **정상 게시판 115개 이상**, 유효한 posting-status와 관측, 원문에 연결되는 실제 공고를 요구한다. 미달은 완료로 처리하거나 기준을 낮추지 않고 IP 제한/출처 실패/제품 결함을 조사한다. 과거 보관 자료에는 130개 모두 정상·6,819개 공고가 있었지만 현재 성공을 보장하지 않는다.

Main과 Astra가 독립 테스트 담당의 정확한 실행 결과와 최종 소스·테스트 해시로 검증 완료에 동의해야 완료 상태로 기록한다. 코드가 검증 뒤 바뀌면 영향받는 검사를 다시 실행한다. 배포 준비를 위한 모든 로컬 검증을 통과한 커밋을 먼저 보존하고, 원격 운영 검증 기록은 후속 문서 커밋으로 보존한다. 실제 deployment/workflow/version/commit과 필수 검사의 실패·재실행·한계를 남긴다.

## 배포와 정리 순서

공통 설계 승인 → 제품·테스트 작성 → 소스·실행 계획 승인 → 테스트 담당의 독립 로컬 검증 → Main·Astra 결과 검토·검증된 배포 준비 커밋 → 원격 push → schedule 비활성 상태로 Worker/DO·secret 배포 → 최초 workflow_dispatch → 독립 운영 smoke → Main·Astra 검증 완료 판단 → schedule 활성화 → 배포 기록 Git 보존 순서다.

원래 worktree의 미완료 81단계 파일을 훼손하거나 포함하지 않고 main에 통합한다. 명시적인 main ref만 push하며 로컬 보관 ref나 태그를 동반 push하지 않는다. 비밀 파일·수집 원문은 Git에 추가하지 않는다.

완료 시 가치 있는 설계·소스·테스트·검증·합의·운영 절차는 Git에 남긴다. 재생성 가능한 82단계 빌드·캐시·보고서·화면·trace·스크립트·작업 공간과 소유한 서버·브라우저·agent는 정리한다. 폐기할 수 없는 운영 원본·관측을 로컬에 확보했다면 중복 없는 무시된 보관 자료로 남기고 이유·위치를 기록한다. 81단계 미완료 근거, `.local/preserved-2026-09-28/`, `.local/observations-v1/`, 타 프로젝트의 8787 listener는 보존한다. 모든 깊이의 `collaboration/*.ndjson`은 stat만 허용하며 읽기·해시·복사·출력·보관하지 않는다.

## 공식 근거

2026-10-03 실제 확인. 저장된 원문·해시는 82단계 검증 기록에 연결한다.

- [Workers 한도](https://developers.cloudflare.com/workers/platform/limits/)
- [SQLite Durable Objects 요금](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Objects 한도](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [SQLite API와 transactionSync](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Durable Object class 선언](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- [Response 자동 인코딩](https://developers.cloudflare.com/workers/runtime-apis/response/)
- [Static Assets 헤더](https://developers.cloudflare.com/workers/static-assets/headers/)
- [KV 일관성 제한](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
- [GitHub Actions 공개 실행기 비용](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [GitHub 예약 실행](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

## v2 논의 반영

당시 Astra CD82-1, Fable F82-1~5와 C1/C2를 수용했다. API 루트·보안 헤더·과부하·health·generation/publication의 정확한 계약을 추가했고, source 시간 경계를 명시했다. Main은 정상 구성 전환과 ID 손상 구분, 응답 시각 fallback, 실제 커밋 발행 시각, 기본/Cloudflare 빌드 분리도 명확히 했다. v1·v2의 각 참여자 의견과 당시 승인은 역사적 기록으로 보존한다. 아직 수행하지 않은 검증과 배포 완료를 승인한 문서가 아니다.

## v3 · 용량 검사 보완과 사용자 지시 반영

아래 보완안 전체가 이 설계 문서의 해시에 포함됩니다. 원래 성능·기능·운영 검증 기준은 유지합니다.

### Stage82 capacity remedy — common candidate05

Status: final user-amended design proposal; phase approvals are recorded separately against these exact bytes. Authority: the user instructed “fable 검토는 제외하고 이전 goal 진행해줘” on 2026-10-05. Main and Astra are the required design/code/result reviewers; a separate test-only subagent independently authors and executes tests. Historical missing Fable assessments remain missing and are no longer prerequisites. No further Fable call, reconstruction or external support message is authorized. Baseline source68d4637464026dca435b64e3440b519687e8145a8583518df1f302232fdcdc7c/526; the original plan04 checks are unchanged in participation-only plan05. The objective remains verified deployment to job.hyunjun.workers.dev, Git preservation and owned temporary-resource cleanup, not merely this workflow amendment.

#### Evidence and unchanged acceptance

Full capacity1227961daf78 completed uncancelled:14executed9passed5failed, no skip/retry/flaky/globalerrors; known owned process/power closure, recovered8790/9230, noSleepWake and identical source. Final facts edb8360928855b972feda79be6babe95914a5033b519148049ec1124a7f5ee05 and infrastructure cd27d40cbb0dcaa68b33596e6bc00fcc24fb6c4f5a044162371f191d664ce955;15attachments99572B and6resultfiles preserved separately. Original failures remain failures.

Keep literal130employers*50jobs,6500servedjobs,3500descriptionchars,90days July6–October3. Keep native cursor.rowsWritten <=2*N+12 (52 at20chunks), daily100000 bound at48publications,512MiB/+1payload,900MiBSQLite, all manifest/chunk/compressed/storage/public/private limits,8paused/ninth503, complete encodings/contents/checkpoints/rollback/retirement. Keep actual attributed heap/RSS and positive validCPU profiles,128MiB criterion with its existing qualified interpretation and30sDO CPU. Do not reduce the fixture, skip unreached checks, substitute logical rows for billing, suppress stage renewal at frozen time or raise thresholds to observed values. Local versus deployed10msWorkerCPU evidence remains distinct.

#### C1 — JSON transport and logical phantom cleanup

In tests/cloudflare/helpers/worker-http.ts storeRoute, serialize a supplied JSON body once and send its exact UTF8 byte Content-Length with Content-Type. Preserve the undefined-body case without creating a body. Leave low-level rawRequest and intentional held/malformed transport probes unchanged. The caller already supplies the valid UUID; do not loosen UUID validation or swallow cleanup errors. Pinned Node defaults DELETE to no automatic chunked body framing.

In tests/cloudflare/runtime/entry.ts only the phantom DELETE seam, preserve the owner/id AND ZERO_HASH predicates, return deleted key rows through DELETE … RETURNING, and count consumed rows.length as logical removed chunks/generations. Preserve native cursor rowsWritten separately and leave product billing untouched. The existing exactone chunk/onegeneration assertion and post-removal payload checks stay intact. This source-only follow-on risk was hidden by the first transport failure.

Serialize supplied null as JSON as usual; preserve undefined as no body/no new JSON headers. Any wire regression for non-ASCII JSON must verify actual helper bytes/length without loosening the native UUID validator. Logical DELETE counts come from consumed RETURNING rows; expose native rowsWritten only under a separate diagnostic label if needed, never as normalized publication billing.

#### C2 — an actually owned, valid exited PID

Replace fabricated4194303 in the sampler witness with a finite child owned by that test. Attach error/exit/close observers from acquisition, obtain a positive live OS identity while the child is held alive, then boundedly stop and reap that same retained child handle. Only after observed termination exercise recheckRuntime and the actual MemorySampler with the formerly live identity. If its PID has been reused, fail closed; do not touch the replacement.

Keep live coalescing, the real ps path, missing identity with null RSS/null peak/unusable interval, and the later delayed-stop/no-second-sample assertions. Do not broaden the normal-no-row ps classifier to accept stderr errors. Cleanup must cover failure at every acquisition stage, join owned termination and preserve primary plus cleanup failures. No foreign PID/port signals and no arbitrary alternative PID.

The held child has observers from acquisition and a bounded orderly input/handle-driven termination and join. Record its real birth/parent/group/command before requesting exit, then observed exit/reaping and stdio closure; a missing ps row alone is not termination proof. Keep the synthetic OwnedRuntime's registered PID metadata consistent with that child and label this as a synthetic sampler witness, not native workerd execution. Expectations remain explicit missing-row/null RSS/null peak/zero valid samples/unusable interval; only the observed PID identifier varies. A replacement identity fails rather than triggering another PID search or signal. All spawn/identity/join failure paths retain independently attempted owned cleanup.

#### C3 — initial chunk-table representation

Main changes only orbit_chunks initial CREATE TABLE in worker/store.ts to WITHOUT ROWID. Keep columns/order/types/NOT NULL/(owner,idx) uniqueness, exact hash/size/BLOB checks, bound SQL, insertion+staging-touch transaction, idempotency, leases/expiry/GC and native metrics. Leave generations/meta/staging representation and all renewal behavior unchanged. Expected first-publication cost2*N+5=45 is a prediction to test, never reported as measured beforehand.

Large BLOBs use a different B-tree layout: fewer billed row writes do not prove less I/O, memory or latency. All original large-body, database-overhead, streaming and lifecycle criteria remain mandatory. A regression defeats this candidate even if its write count fits.

This remedy supports rollout only after establishing a first deployment with a fresh Worker SQLite namespace. Freshness has not been independently rechecked in this design review. Deployment must recheck the approved account/target and establish that no pre-existing unknown/populated Worker namespace is being adopted. Bind the newly created namespace to the eventual deployment record. If that precondition fails, hold for a preservation/migration design; never wipe data. CREATE IF NOT EXISTS is not an old-layout migration. The existing fictional-test reset uses native deleteAll/deleteAlarm plus verified fresh-instance abort; it is not permission to reset production or protected data. No new general migration framework is proposed for an unshipped schema.

For case10, retain actual before/after native metrics and product instance identifiers around publication. Require valid matching instance identity and monotonic native counters before taking deltas; do not let an epoch change or negative/small reset delta satisfy52. Record the fresh chunk-table layout once in the existing native case if needed to establish that the new initial DDL was exercised. Exactly45 and per-statement decomposition are not new success oracles. Instrumented product SQL, direct harness SQL, logical removed rows, disk pages and platform billing have distinct scopes.

##### C3b — case13 same-owner release attribution

Keep the historical case13 pass with its limitation: its pinned and final metrics came from different product instances. That final fresh zero is not proof of release by the pinned instance.

Record product instance and relevant store-state clock/instance evidence at pin. Immediately after slow.finish(), before the expensive complete-body assertions, perform the existing bounded release observation against that same pinned product instance. Keep the60s bound; loss/replacement of that instance before a release witness is a failed/unavailable attribution, not a fresh zero substituted for release. Preserve primary and cleanup errors.

Keep every full body assertion at the07:05 request-start clock, the07:10 store clock for GC, the later sweep,410 result and exact retained generations/chunks/bytes. Once same-owner release is witnessed, a later observed reconstruction need not invalidate persisted GC correctness; record it and verify the intended store clock. Do not artificially keep an instance alive, persist pins, add reader demand or demand immobility through expensive post-body validation. An unchanged outer HTTP nonce alone does not prove the DO isolate/actor identity or explain its eviction.

#### C4 — explicitly bind and retain the advertised execution context

Evidence and limits

The immediate call has no explicit context. The pinned proxy keeps Runtime enabled across frontend clients. Saved workerd/V8 references support a missing default context and fresh reporting after a disabled-to-enabled transition. Upstream excerpts are not rebuilt-binary proof; the actual native full run must still establish successful acquisition and all later measurements. Close1006 confirms an observed close consistent with terminate, not peer-side ordering. Two failures do not establish deterministic reproduction.

##### Acquisition and identity

1. Keep the owned-process/port checks, both singleton discovery responses, matching target/endpoint, pinned version, Origin and socket ownership. Record partial acquisition evidence from the first discovery step, even when no socket has been created.
2. Observe context-created/destroyed/cleared events from socket ownership. Preserve counts and bounded lifecycle history separately from the working live inventory. Accept only the pinned protocol's valid field shapes; names/origins are evidence, not identity substitutes.
3. Obtain a correlated nonempty isolateId, then make one correlated Runtime.disable/Runtime.enable handshake before measurement. After the disable response, clear only the working inventory immediately before enable. Retain earlier events and all context-clear counts. No arbitrary wait, reconnect, retry loop, counter reset or suppression of measured notifications.
4. At enable completion, freeze a discovery revision. Evaluate each advertised live context once with its explicit uniqueContextId and the fixed nonce expression. Require safe positive numeric IDs and the stable nonempty uniqueId supported by the pinned source. Missing/incompatible identity is a visible acquisition failure; do not guess context1 or silently switch addressing modes.
5. A valid undefined/nonmatching nonce is a nonmatch. A malformed CDP result, exceptionDetails, RPC error/timeout, destroyed candidate or changing inventory/isolate is a failed acquisition, not another nonmatch. Require exactly one live match to the owned HTTP nonce, unchanged discovery revision, and a final correlated isolateId equal to the initial one. Do not choose by the label Worker alone.
6. Save both numeric/unique context identity, isolateId, target/version, discovery phases and nonce-match result. Preserve unavailable fields explicitly and early reference bodyBytes. A connecting placeholder without obtained evidence does not satisfy failure retention.

##### Binding lifetime

Once bound, destroying/clearing/replacing that context or changing the isolate irreversibly invalidates the interval. An unrelated context event does not automatically destroy the binding, but its history is retained. Never silently rebind.

Check the sticky binding state before and after asynchronous bound evaluation, heap/GC and profile start/stop operations. Keep correlated isolate checks on samples and at profile boundaries. An event arriving during an awaited operation must invalidate that result; a pre-call check alone is insufficient. Every failed operation retains original diagnostics and enters normal independent cleanup. Preserve existing no-context-clear, protocol-error and process-identity expectations.

##### Bounds proposed for explicit agreement

Use at most16 simultaneously advertised contexts,128 retained context-lifecycle entries, and4096 UTF8 bytes per normalized context descriptor. These are proposed test-client evidence/discovery work bounds, not product capacity or protocol maxima. Pinned source registers Worker/Compiler contexts but does not establish the actual native count or prove a measured margin; the proposed16 bound remains an explicitly reviewed engineering choice, subject to real acquisition evidence. A cap failure must not be silently converted to another limit or a pass.

Normalize a created descriptor into a fixed-order JSON object containing id, uniqueId, name, origin and, only if originally present, its parsed JSON auxData value. Preserve those values exactly; do not truncate, coerce or normalize away identity/name/origin differences. Require the pinned protocol's field shapes; auxData is retained as opaque JSON and is never an identity selector. Compute4096 against the UTF8 JSON encoding of this object. Unknown descriptor field count may be recorded without treating unknown fields as identity. Lifecycle entries retain the event kind, discovery/bound phase and the identifiers supplied by the pinned event schema; created entries use the normalized descriptor, and clears retain their phase/count. These selected fields are a documented projection, not a claim to preserve the entire wire message.

Each cap/overflow retains aggregate counts, the reason and observed byte/count extent, and irreversibly fails acquisition/attribution. An overflowing descriptor is marked unavailable in full; do not retain a shortened identity and use it as a valid descriptor. Never silently drop required identity/history to fit a cap. Keep aggregate counts for otherwise ignored events; a general event histogram is optional, not a new test matrix.

Keep existing per-discovery/open timeoutMs and the existing30s RPC bound. A successful acquisition makes at most4+16 RPCs (initial isolate, disable, enable, up to16 nonce evaluations, final isolate). The sum of configured timed-I/O budgets is4*timeoutMs +20*30000ms before cleanup,640s for default timeoutMs10000. This is not a proven hard wall-clock bound: loadWs/import, parsing/module execution and event-loop scheduling are outside that sum. It is not measured latency or a new performance goal. The existing1800s case/7200s full-capacity deadlines remain unchanged. A smaller total deadline is a separate proposal and must not be implied by the current connect(timeoutMs) argument.

The cap choices and any additional RPC required by the implementation need exact final design review. They must not become hidden arbitrary thresholds in authored tests. No new waits may be added simply to obtain an RSS tick or make a heap trend visible.

##### Shared-domain cleanup

Track whether a disable may have been sent and whether a correlated enable succeeded. A timeout/error does not prove disable had no effect.

On failed premeasurement acquisition, if Runtime may remain disabled and the already-owned socket can still carry a request, attempt at most one restorative Runtime.enable with a bound of min(timeoutMs,3000). This does not recover the failed measurement or authorize a second acquisition. If the channel is closed, restoration fails/times out or state cannot be confirmed, record Runtime-state-unconfirmed as a secondary cleanup limitation; never reconnect or probe another port. Then independently terminate and observe socket closure within min(timeoutMs,3000). Total extra cleanup is at most6000ms at default settings.

If normal enable already succeeded, do not reset Runtime during later acquisition cleanup or measured phases. Preserve the original failure, restoration result, pending-call rejection/timer cleanup and confirmed/unconfirmed socket close separately. A restore failure must not prevent attempted socket cleanup or erase the primary cause. Future code must demonstrate these bounds rather than just returning a success flag.

A correlated restorative enable confirms the Runtime domain is enabled. It does not restore all bindings, compiled-script state, formatter/debugger settings or the observation gap removed by disable. Preserve that scope limitation; do not describe it as complete restoration of previous inspector state.

##### Owned profiler cleanup after invalidation — ASC03-R1

Profiler commands have effects even when a later binding check rejects the interval. Track enable-may-have-been-sent and start-may-have-been-sent before issuing those commands, and their correlated enable/start/stop/disable acknowledgements separately from measurement validity. A successful promise alone must not hide the case where the operation took effect before an awaited context invalidation. Check sticky binding validity between every awaited enable/setSamplingInterval/start sub-operation, and before/after normal profile stop. Do not send later measurement operations after invalidation.

Add a separate bounded cleanup operation for this inspector's possibly enabled/active profile. It must not call a normal stopProfile entry point whose measurement-validity guard would prevent cleanup. With the same owned socket/target still usable and a correlated getIsolateId equal to the retained owned isolate, attempt at most one Profiler.stop if start may have taken effect without an attributable stop acknowledgement, then at most one Profiler.disable if enable may have taken effect without a disable acknowledgement. Do not let a stop error alone suppress the disable attempt while ownership remains attributable. If the channel/target changes or isolate identity is mismatched, absent or unconfirmable, do not issue profiler commands to a replacement: record the original profile state as unconfirmed and independently close the owned socket. No reconnect, rebinding, new profile or Runtime reset is permitted.

Each cleanup RPC has a proposed3000ms limit. At most four are used: initial getIsolateId, conditional stop, conditional disable, and final getIsolateId. The final identity check qualifies the acknowledgements; mismatch/error or a known target/ownership change during cleanup leaves attribution unconfirmed. Thus profiler cleanup has at most12000ms of configured RPC budgets. Independently attempt pending-call/timer cleanup and the existing Inspector.close operation, retaining its5000ms default; the combined timed-I/O allowance is at most17000ms. These are explicit proposed cleanup budgets within unchanged1800s/7200s deadlines, not a new throughput criterion or a proven hard event-loop deadline. Failed premeasurement acquisition has no owned profile, so its existing Runtime restoration/termination path remains separately bounded by6000ms.

Preserve primary measurement failure, each attempted/skipped cleanup action, acknowledgements, identity evidence, failures and confirmed/unconfirmed closure separately. A stop acknowledgement from the attributable owned isolate can record a stopped profile even if the context measurement is invalid; its raw result is never promoted to a valid measured CPU profile. A lone disable acknowledgement is not a substitute for missing stop/identity evidence. Unexpected cleanup errors remain failures, even when a later cleanup step succeeds. Successful normal profile measurements keep their original raw-profile/positive-duration/sample/reference/time-delta oracles; cleanup cannot rehabilitate a failed interval.

Extend the existing proposed awaited-invalidation witness to include same-isolate context destruction just after possible Profiler.start, and an earlier invalidation after enable. Require rejected measurement, the appropriate bounded profile cleanup and independent socket cleanup. Cover a cleanup error/identity loss without suppressing later safe cleanup or falsely claiming confirmation. No native profile leak is asserted from the static source alone.

##### Tests and preserved oracles

The independent test-only subagent authors the test helper/spec changes after Main/Astra common design approval. Keep all existing fake refusals and genuine native cases. Add compact witnesses for implicit-default rejection/explicit binding; two sequential frontends on the same already-enabled upstream; absent/wrong/unique/ambiguous nonce contexts; stale replay versus fresh inventory; bound-context destruction/replacement during an awaited operation; enable failure after possible disable with successful/failed/unavailable restoration; and bounded pending-call/socket cleanup. Combine related assertions into meaningful cases rather than multiplying every independent fault combination.

The fake models the pinned source contract, and the full real capacity run remains decisive. Preserve all literal fixtures, response content/size, eight-held/ninth-refused, drain/cancel/release, usable interval RSS, positive valid raw profiles and all original upper bounds. Do not require heap monotonicity, a particular sampled source URL, incomparable timestamp containment, a tick in every short RSS phase or code1000 for every real closure. Record those observations and limitations where useful. Keep the existing controlled fake's explicit code1000 assertion.


Additional pinned source confirms Runtime.evaluate passes uniqueContextId through ensureContext, resolves it explicitly, and rejects simultaneous numeric contextId plus uniqueContextId. Send only uniqueContextId as the address; retain numeric identity for lifecycle evidence. References: main/capacity-remedy-01/pinned-v8-context-selection-reference-01.json and pinned-v8-evaluate-selection-reference-01.json; same upstream source hashb8bc6ab5f32b1f71c9e70238a8cf03984ea16439f896cc3fe26cdd19dfeaac92. Native/patched-binary limitations remain.

#### C5 — close and recover after the existing header-only rejections

The original401/Bearer,409,409 complete responses with zero client body bytes passed. Three late request-stream-after-response TypeErrors and a NOSENTRY warning remain separate diagnostics. Pinned native source maps SENT_RESPONSE to the exact FAILED exception after response proxy completion; outgoing request bodies pump concurrently under addWaitUntil and ignore only DISCONNECTED. This source mechanism supports a bounded native lifetime explanation but does not localize the emitting hop. No Wrangler-only or universally harmless claim; no telemetry-upload inference from a warning name.

Strengthen the existing three requests, without sending/draining their withheld bodies or changing methods, declared1MiB/+1lengths, statuses or precedence. Latch response-end and request error/close plus the actual acquired socket close from creation. After the complete response, destroy only its owned request and boundedly join the request/socket terminal events, including already-fired events. Distinguish intentional cleanup from late errors, preserve primary and secondary failures, and reject missing closure or unknown/new errors. Do not enlarge case/check timeouts to quiet output.

ASC03-R2 applies on every failure path, including a response that fails before end and partial acquisition before the caller receives a handle. Make openHeldRequest acquisition awaitable so its own catch can finish bounded owned cleanup before rethrowing a partial-acquisition error; update its three existing callers in this same spec. No other current call sites were found by a static tests-tree search. Attach ownership/error/close/socket latches before flushHeaders and other fallible post-acquisition work. An earlier failure with no acquired request/socket must be explicitly distinguished from a resource whose closure is unconfirmed.

Each acquired handle owns an idempotent cleanup promise with one proposed3000ms request-and-actual-socket join budget, starting when its destruction/cleanup is first requested. Include already-fired events. If an acquired request closes before it ever obtains a socket, report that observed no-socket outcome rather than waiting for or inventing a socket close; a complete-response witness must still have its actual socket evidence. A destroy error must not skip that handle's remaining safe close observation. Do not reset the timer or retry destruction merely because a caller/finalizer invokes cleanup again.

The caller registers every returned handle immediately. After a complete response it destroys/joins that handle; on every exit it independently invokes/joins cleanup for every acquired handle. Use separate finalizer steps or collect all settled outcomes so one failed join never prevents the rest. Helper-internal cleanup covers a handle not yet returned. Each of at most three handles consumes at most one3000ms join budget across its owner/finalizers, at most9000ms total configured join waits in this case; ordinary response timeouts and overall case/check deadlines remain unchanged. Preserve the response/assertion/acquisition failure plus all cleanup failures. Record intentional cleanup and late errors explicitly; do not suppress all errors of a common code or native warning text.

The recovery GET runs only after confirmed closure of all three original requests. It cannot turn an earlier response/assertion/cleanup failure into a pass. Add a compact helper witness for response failure before end, partial acquisition cleanup, and one failed join while another acquired handle still receives cleanup; these can share controlled setup rather than multiply a fault matrix.

After all three closures, use one authenticated GET /__orbit/publish/head through the same owned origin/DO. Verify the actual status200 and complete decoded JSON exactly {"head":null,"manifest":null} for this freshly wiped case. This is not HTTP HEAD and not only contractClient.head(), whose response.ok handling and null normalization do not establish the exact status/raw object. An open port or arbitrary200 does not establish recovery. Keep all ordinary diagnostics and their ordering; do not filter text or require exactlythree warnings as a success oracle.

If those closure/recovery observations pass and the remaining diagnostics match the source-supported bounded rejection episode, Main and Astra may review a narrowly worded native limitation with the emitting layer still unknown. This is not preapproval of that disposition. Client closure is not direct observation of every internal native task; recovery is not a long-run resource guarantee. Missing closure, truncated replies, failed recovery, new errors or continued diagnostics outside the episode require further diagnosis. Attribution by an owned-path comparison or equivalent evidence is required before blaming only Wrangler or adding a product forwarding cancellation patch. No downstream abort patch is proposed now: abort after headers can truncate the response body.

#### Write scopes, gates and verification

Main: worker/store.ts plus integration/docs/metadata and the explicit participation-only validation control amendment. The test-only subagent: tests/cloudflare/helpers/worker-http.ts, tests/cloudflare/runtime/entry.ts, tests/cloudflare/helpers/instrumentation.ts, tests/cloudflare/capacity-instrumentation.spec.ts, tests/cloudflare/capacity-realistic.spec.ts, tests/cloudflare/controls/archive.ts, tests/cloudflare/controls/stage.ts, tests/cloudflare/controls-faults.spec.ts and its own independent reports only. Preserve unrelated original tests, all literal bounds and approved G3/observation regressions. The control tests must use the exact revised stage-identity/run-validation control bytes and retain synthetic wrapper-fault coverage; the synthetic fake-claude fixture is not a real model invocation. No production secret/provider/data changes, dependency swap or plan check-command change.

After Main/Astra exact-hash design approval, Main and the independent test-only subagent implement their disjoint scopes. Main and Astra independently review exact final source/tests before peer exchange. Main/Astra explicit implementation votes bind a fresh complete inventory and participation-only plan05. The separate test author reports readiness and later actual results independently; no execution on a held source gate. Any correction requires review of changed bytes. The explicit control amendment changes only the required vote tuples in stage-identity.py and run-validation.py from Main/Astra/Fable to Main/Astra. run-review.py stays unchanged and is unused; actual allowed modes are identity and execute. Keep actual ownership, process/power/port, deadlines, actor authorization, final cleanup and remote ledger safeguards unchanged.

Candidate verification policy (fresh checks replace older suggestions to carry unit/default-build results): run the ordinary plan05 checks (identical to plan04) on final bytes, excluding only already proven unchanged install/browser prerequisites. This includes roottypes, fullunit, defaultbuild, Workertypes, CFbuild, dryrun, fullWorkercontracts/lifecycle, CLIcontracts, fullWorkerUI, fullcapacity including added witnesses, local control/transport/browser guards, complete83-fileproduction and exact18-filedevelopment selections (G3 in both). Do not replace full selections with narrow runs. Stop after a failed/incomplete check, preserve evidence and reconcile before more execution. Required remote ledger/smoke/CPU/data freshness checks still follow only the approved deployment/collection procedure; no earlier local result is relabelled as remote acceptance.

After all required local checks pass, Main/Astra local pre-deployment review must inspect final results, failures/limitations and C5 disposition on the same final identities. Preserve that verified local step in Git, then follow the already approved deployment/first-collection procedure with scheduling disabled. Do not require remote results before their deployment prerequisite, and do not label local acceptance as whole-stage completion. After the actual deployment/collection identities exist, complete the original remote ledger/smoke/attributable CPU/data-freshness criteria and Main/Astra remote review before scheduling enablement and whole-stage completion. Preserve each completed approved step in Git. Cleanup follows the relevant evidence/consensus/Git preservation, retaining the protected44 data files,22originaldirtyfiles and private execution-metadata originals. No product/test execution is authorized before the applicable exact-hash source gate is approved.

#### Input and participation record

Main's exact new input notes are main-context-design-addendum-02.md and main-helper-design-addendum-01.md in this directory. Astra's new native review is independent/capacity-remedy-01/astra-native-capacity-remedy-update-01.json, SHA256 de016b44a3bcec21639081732eb2cc311f014aff3884407d938e7efbef6c5a4e. Its ANCR82-U1/U2/U3 are addressed by the case10 epoch checks, C3b and the exact C5 recovery/cleanup scope above. Main agrees these are required design clarifications, not evidence that the implementation works.

Historical participation: fable-user-directed-whole-first-01.json (47e5d6b74cb32118d904fe7e413bb511182f8b80934349b67f8b0b56549f45a8) is an incomplete completion record, not a whole assessment or design vote. That status is preserved. The explicit user waiver supersedes the former requirement to obtain that first assessment; it does not supply it or convert it into consent.


#### Candidate04 change record

This revision preserves candidate03 (857c7fcb66e23efbfd293e37e8664050c5f0f47450d618fd4c0543db37eeb6a9) and incorporates Astra ASC03-R1/R2 from astra-shared-candidate03-review-01.json (e5565e11536a74de19dc321a087a0e77304441eeba59bd7707498f6bb2c4b03b). Main confirmed the referenced startProfile/stopProfile/close/finalizeCase and held-request paths as text, and accepts both required amendments. The16/128/4096 choices remain proposals with explicit field projection and unmeasured-margin qualification. The640s sum is now explicitly timed I/O, and Runtime re-enable is not misreported as restoring all old inspector state.

Candidate04 historical status was unapproved pending the former Fable whole-first and all-three procedure. Astra subsequently resolved ASC03-R1/R2 at proposal level and reported no remaining product/test design blocker in astra-user-waiver-design-readiness-01.json. Those reports do not approve candidate05 or establish native test results. This candidate preserves the product/test remedies and original numeric acceptance; only the explicit current participation/control/plan procedure is amended. Main/Astra must cast new votes on the final deployment-design document containing this complete candidate, the workflow files, revised control hashes and plan05 identity. Source and execution gates remain held until their own required review.

## v4 · 고정된 native profiler와 GC 계약 보완

아래 remedy03은 v3의 generic CDP 계약을 보존하고 명시적 native 모드·정리·GC 및 해당 검사 재사용 절차만 보완합니다. 앞선 17통과/2실패 결과는 실패로 보존하며, 이 문서 전체와 실행 계획의 새로운 해시에 대한 Main/Astra 승인 전에는 작성·재실행을 허용하지 않습니다.

### Stage82 capacity remedy03 — design candidate01

Status: PROPOSED, not implementation or execution approval. Required reviewers are Main and Astra; Fable remains excluded by the user's decision. The historical blocked Astra review remains unreceived. Transfer this document and its referenced material by path and full SHA-256.

#### Evidence and scope

The approved source2304252813fe40542d76666e4d769a4ed493455f18262fd90c7e4accb3fa8c93 / planb3b0a5cd3194b942dec9c5f0bb2fb154516b3283689959711f020463368efc1c produced nine successful local checks, then worker-capacity-edbf78a6579f failed17/19 with19 attempts and no retry, skip, flaky case or global reporter error. All18 attachments and dispatcher process/power/port closure were preserved. The two case-local profiler/inspector failures remain failures.

This amendment is limited to capacity test instrumentation and independent witnesses. Product code, test runtime entry, HTTP behavior, dependencies/vendor code, control-source pins, workload and acceptance thresholds stay unchanged. It supersedes the earlier C4 profiler/transport details only for an explicitly selected pinned native mode; generic CDP and its existing witnesses retain their contracts. Forced-GC support receives the ordered I/O turn described below. C1/C2/C3/C3b/C5 expectations remain.

Evidence files, relative to `.local/research/82/`:

- `independent/capacity-remedy-03/astra-failure-static-review-01.json` — 559c5a63f54b78d9fd43b464fdbdd1138b60d6ae5070b5c16d74823afd0fc81c.
- `independent/capacity-remedy-03/astra-native-gc-review-01.json` — c50a890decfb8e416affe0c9d5ee6a4570c76b286fdfba4bb9b32a447ec6adb9.
- `independent/capacity-remedy-03/test-agent-preparation-01.json` — 225d5c8f3cefac49dfe30295587b61806c8a044601034072cff5207ba4b94a63.
- `independent/capacity-remedy-03/test-agent-preparation-02.json` — 5e3c66c9aa283c5d818b3f0b86dd694abef05eec39079f6c3e3f726fcd3dcfbd.
- `main/capacity-remedy-03/native-profiler-http-assessment-02.json` — f18559aa09568bce301ba1ad7d537c1bf887fab680cba7198f6a1e865ed889df.
- `main/capacity-remedy-03/native-profiler-disposer-reference-01.json` — 9078b1e7c6b70199087e018af342aae7b13d486db7ed5784011d2db01c573dca.
- `independent/verification-remedy-02/local-results-failure-01.json` — 15bc76c4c6e338fed700255a3204607b1bdd6370a259471ac9a3fefd569fb8d8.
- `main/capacity-remedy-03/terminal-capacity-reconciliation-01.json` — ab97a30d6957d559234cb01728089b24d88c86d2a9a873ba96b90895ec3ed95a.
- `main/capacity-remedy-03/attachment-audit-01.json` — 866a6f88d742d228d9d99a41c3a455beb182502be41645d051efd71c46ecd389.

The native public source matches workerd1.20261001.1, npm gitHead402f058c655b01fa58ba1ed711061cf3bc7d896b, with V8 15.5.35.7 and the recorded43 patches. This is version/source provenance, not a rebuild or binary attestation. The old request-shaped proxy log is not a client wire capture.

#### Explicit native mode and custom-profiler ownership

Keep generic mode as the default. Genuine capacity clients explicitly select the reviewed workerd1.20261001.1 / Wrangler4.147.0 native contract; do not infer it from a reflected frame. Retain owned-run/process/endpoint checks, exact Wrangler discovery/version, explicit unique-context nonce binding and all sticky invalidation guards. Verify and record the installed workerd/platform and Wrangler package version provenance before native profile operations. The heap-only client receives native transport/GC support but no permission to invoke or replace the CPU profiler.

Only the genuine encoding/CPU case may own the native custom profiler. Make this an exclusive, nontransferable claim for the complete dispatcher run, not a default flag on a fresh frontend. Before any possible custom enable, atomically create one `native-profiler-owner-claim.json` in that run's verified `verification/<run>/` directory, derived from its already validated runtime process-registry path. Use exclusive creation and mode0600. Record the run, owned runtime identities, claimant and source/protocol provenance; keep the claim immutable. Existing, unreadable or partially written claims conservatively refuse a new profiling owner. Do not unlink, recover, transfer or overwrite a claim to obtain another attempt. A fresh Node/Playwright worker cannot bypass it. The run's normal preservation/cleanup owns this local evidence file.

The claim relies on the fresh, exclusively launched owned runtime and the reviewed single profiling case/retry0 scope. It does not attest to arbitrary outside inspector activity. A detected frontend/target/socket change remains fatal. Heap-only cleanup claims only that it issued no profiler commands; it does not confirm any predecessor's global native profiler state.

Inside the claimed client, track enable/start epochs and possible side effects separately from acknowledgements. A distinct native stop-effect proof belongs to the retained channel, target, original isolate and current owner/start epoch. Old proof cannot authorize a new epoch's replacement. Both the `Profiler.enable` in a later `startProfile` and the final cleanup reset must use the same inactivity predicate. Refuse overlapping start/stop/cleanup or a reused/transferred claim before a replacement command can be sent.

#### Native command returns and complete stop evidence

The pinned workerd custom dispatcher handles `Profiler.enable`, `Profiler.setSamplingInterval` and `Profiler.start`, then encodes the same command with its params union intact. In native mode only, recognize this exact producer-specific return for those three pending methods. Require:

- A positive Int32 correlated request id, the exact pending method, and exactly the expected `id`, `method`, `params` envelope keys.
- An object params value with the exact immutable sent keys and values; empty params for enable/start and the exact finite positive Int32 sampling interval for the interval command.
- No `result` or `error` property, including explicitly present null; no changed/extra/omitted fields, scalar/array/null params, or method mismatch.

This is not a general missing-result fallback. Generic mode still rejects reflected commands. Standard error/result contradictions remain failures. Unissued proxy-internal ids never satisfy owned pending work. Typed identity, evaluation and heap results keep their requirements.

Native `Profiler.stop` must use the producer's `id`/`method`/`result` envelope, exact method, no params/error property, and `result.profile`. A reflection, generic object or missing/malformed profile cannot establish a stop effect or authorize a reset.

Validate the complete native profile before granting a stop-effect permission: required nodes/startTime/endTime/samples/timeDeltas; a nonempty root-first node tree; unique positive Int32 node ids; valid child/sample references, no cycles or inconsistent parents; correctly typed callFrame fields (string functionName/scriptId/url, Int32 lineNumber/columnNumber, including legal negative sentinels); equal-length samples/deltas; finite nonnegative timestamps with endTime>=startTime; nonnegative Int32 deltas. Validate schema-defined optional hitCount, children, positionTicks and deoptReason if present, including their member types. Required fields set by the producer cannot be replaced with synthetic defaults. Optional absent metadata remains absent.

A structurally valid stopped profile with zero samples, zero duration or zero total delta is cleanup-effect evidence only. Measured CPU acceptance still requires positive duration, nonempty valid samples and a positive total of time deltas, the original CPU criterion and unchanged attribution. Retain full raw profiles; do not calculate expected test profiles through the implementation validator.

Preserve native return/rejected-frame diagnostic bytes before lossy conversion: raw UTF-8 payload, byte count/hash, request/method/phase, monotonic arrival and field shape. Limits are4096 raw bytes per diagnostic frame,64 retained frame records and65536 aggregate raw bytes per inspector. Explicit overflow/truncation makes the affected operation fail; bound metadata retention after overflow as well. Valid complete stop profiles are retained separately from these small-frame diagnostic limits. A profile is never validated or accepted from a truncated prefix.

#### Native profiler finalization

Generic conditional stop/disable behavior, including disable after an ordinary stop error on a still-owned channel, stays unchanged.

The native owner has a different disposer contract. Its `Profiler.disable` goes to a separate generic V8 agent and does not dispose workerd's custom profiler. The V8 custom-profiler destructor requires inactive profiling. Therefore native finalization is:

1. Check original isolate identity on the retained usable channel.
2. If a start may have been sent in this epoch and no attributable valid stop-effect proof exists, attempt one native stop and validate its effect evidence.
3. Reset through exactly one custom `Profiler.enable` only when no start could be active in the proven owner epoch or a current attributable stop-effect proof exists. Ordinary stop error, timeout, reflected/malformed stop, unknown predecessor state, protocol error or target/identity loss forbids reset. Preserve the resulting unconfirmed state.
4. Check final original isolate identity to qualify the actions.

There are at most4 cleanup RPCs, each at most3000ms; configured RPC allowance remains12000ms. Cleanup is idempotent and shares one promise. Stop failure never prevents independent transport cleanup. Native reset is reported as disposal of the stopped old owner/profiles and creation of a fresh inactive lazy-logging owner. It is quiescence, not generic disable or zero remaining native allocation. Final owned runtime teardown disposes that fresh allocation. No reset repairs a failed measurement or clears invalidation.

#### Native transport closure

Keep generic close and its graceful1000 and stalled/unconfirmed witnesses unchanged. Acquisition/restoration cleanup keeps its existing separate shorter bounds.

The explicitly selected native transport policy uses one monotonic total deadline. At the normal5000ms budget, install close observation first, request graceful close, allow1000ms grace, then terminate only the same retained socket if needed and observe its actual close event before that original deadline. For a shorter positive budget, grace is `min(1000, floor(totalBudgetMs/5))`, reserving the remainder for the event join. Validate budgets before side effects.

Record graceful/forced/unconfirmed closure, code/reason, monotonic times and close/terminate errors independently. Deadline comparison uses the observed event time, not timer callback ordering. A terminate return, readyState or proxy close log is not proof. A later event does not rewrite an expired result. A real close after a call error can confirm transport closure but retains the error and must fail the realistic finalizer. Idempotence never creates a new budget.

#### Forced GC: one ordered I/O opportunity, original deadline

The pinned V8 GC agent queues a non-nestable foreground task. Inspector dispatch runs microtasks but does not pump that queue; an ordinary Worker IoContext turn does. The retained late GC result supports investigating scheduling but does not isolate the historical delay. That causal uncertainty stays recorded.

Keep all four existing forced-GC sites. After the existing `HeapProfiler.enable` acknowledgement, start exactly one `HeapProfiler.collectGarbage` command and immediately attach settlement handlers. Preserve D = that command's monotonic send time +30000ms.

Send one subsequent `Runtime.getIsolateId` on the same socket, using only time remaining to D. Its typed, correlated original-isolate reply supplies an ordering barrier; it does not supply GC success. Only then perform one GET to the validated owned origin's existing `/__test/identity` route. Successful cycles use exactly one such request, even if GC has already completed; failed earlier steps send none. There is no repeated wake, guessed sleep, second GC, new socket or rebind.

The owned GET uses an absolute deadline, agent:false, Accept-Encoding:identity, no redirect following, a4096-byte complete-body cap and early request/socket/error/response listeners. Require status200, unencoded complete valid JSON with literal harness `orbit-worker-contract`, storeName `catalog-v1`, entry `tests/cloudflare/runtime/entry.ts`, and the original isolate nonce. Validate before using the result. Require response end plus observed request/socket closure; an end-only or uncancellable rawRequest race is insufficient.

The original GC reply must be a correlated strict object success and arrive by D. Require the HTTP witness and final unchanged binding/isolate qualification by D as well. Every new barrier/HTTP/qualification wait uses remaining time, never a fresh30s allowance. Store all send/ack/end/close/deadline times, ids, nonce/binding and the observer activity. Do not subtract the small identity request's overhead from raw heap/RSS measurements.

If an operation fails or D expires, keep the failure and possible queued native GC effect. Immediately cancel outstanding owned HTTP work, start its one at-most3000ms request/socket join, attach settlement handlers and retain its cleanup promise while rejecting the cycle. This failure-only join does not extend D or qualify a late reply. Join it independently alongside the existing at-most12000ms profiler cleanup, then perform the separate at-most5000ms inspector close: the configured pre-close/close allowance remains max(12000,3000)+5000=17000ms, not20000ms. Use all-settled/error-preserving composition so neither cleanup can suppress the other. Keep HTTP and profiler outcomes/failures separate. At most one wake handle can remain per cycle; no overlapping cycles, second wake or new join budget. The1800s case/7200s suite bounds stay unchanged.

Timeout or client closure does not cancel a native queued GC. Late replies are evidence only; they cannot satisfy another request or rehabilitate the expired cycle. Failure of the candidate in a future run requires a new review, not another wake or timeout extension.

#### Specific request-stream diagnostic disposition

Main proposes qualification only for the three deliberate withheld-body PUTs in the retained passing auth case. Their actual401/Bearer,409,409 with zero transmitted bytes, three confirmed request/socket closures and authenticated200 exact null head are preserved. Product authentication/staging checks precede body reads.

Pinned workerd global-scope source emits the exact FAILED/TypeError when a request stream is invalidated after response proxy completion. Its bidirectional fetch body pump is a waitUntil task and ignores only DISCONNECTED; the trace warning records exceptions with a non-exception HTTP outcome. This supports a native background forwarding/lifetime explanation for those three post-response diagnostics. The logs have no JS stack, so exact pump-instance attribution remains a limitation.

No global warning filter, product change or exception suppression is proposed. This disposition needs Main/Astra agreement and applies only to the evidenced incomplete-upload path. New warnings, wrong responses, nonzero sent bytes, unknown closure or failed recovery remain unresolved/failing. Future native results must still be reviewed.

#### Authoring, witnesses and later gates

After explicit Main/Astra design agreement, the independent test author may edit only:

- `tests/cloudflare/helpers/instrumentation.ts`
- `tests/cloudflare/capacity-instrumentation.spec.ts`
- `tests/cloudflare/capacity-realistic.spec.ts`

The preparation addendum proposed a fourth file, worker-http.ts, for the new owned GET. Main chooses the equivalent bounded helper inside instrumentation to keep the existing shared HTTP helper and its verified consumers byte-identical. This is an explicit scope choice for joint review. Do not edit product, runtime entry, dependencies or vendors. No author-side execution until final whole-source/plan approval.

Preserve all original19 cases and every generic oracle. Add independently constructed native command/byte-limit, stop-effect/epoch/claim, transport, and ordered-GC witnesses. Cover unsafe next-start enable, unknown predecessor/new frontend, atomic claim refusal, ordinary native stop error, malformed/late stop and final identity loss. Cover absent/late close and close-call error followed by real closure. GC witnesses must distinguish dispatch from acknowledgement, reject wake-before-barrier, retain30s deadline, refuse repeated wake/retry, propagate changed identity/context, malformed/error/late reply, never-ending or oversized HTTP response, request/socket close failure and failure-only cleanup. Use literal fake producer state/frames and independent unsafe-reset counters, never implementation-derived expected verdicts.

Only the subsequent exact final source/plan review can authorize verification. Proposed affected reruns are root typecheck, both complete builds, dry-run and full capacity. Five previously unexecuted local checks and two deferred remote checks remain required. Potential carry of unit/Worker type/contracts/CLI/UI is conditional on exact unchanged dependency inputs and, for UI, rebuilt served-artifact equality; it requires explicit Main/Astra review and preserves original run/source labels. This conditionally replaces the v3 blanket fresh-check policy only for unchanged checks that already passed on source23042528 in this continuation; no older run or failed capacity result is eligible. No carried-result decision is made by this candidate. All19 execution-plan check definitions, order, ports, commands, deadlines and network constraints stay byte-equivalent.

Full native acceptance still includes literal130×50 jobs,3500-character descriptions,90 days, original decoded/compressed/storage boundaries,8-held/ninth503, all encodings and drain/cancel/release phases,128MiB qualified heap criterion, supplemental RSS/growth evidence,30s local DO CPU and separate10ms deployed Worker CPU. Production83-file and development18-file E2E scopes remain. No deployment, collection or scheduling approval follows from design or implementation approval alone.

## v5 amendment: exact GC deadline oracles and bounded HTTP ownership evidence

This amendment changes test observation and its verification disposition only. Product code, runtime entry, native/vendor code, dependencies, workload, response bodies, production behavior and numerical acceptance limits remain unchanged. It incorporates the agreed numeric correction proposal `ec3a9ff42695d36a55b0abbefbe520676f9f12142bedb59318f8af8395f78963` and the diagnostic direction `d905907d742e99ff4585cd2a413cbad5ae1e22125518a2256c9fe7812a7a32d2`, reviewed by Astra in `fc48c9bcca0476e78a26ce5454657c0595e0b03ba88dcd349b0b7a9fbbe5b68e`.

The intermediate source is `84b3e18830add966d4819fc864b72ddcad10a55778731c5b413868c28597741c`, 526 files, inventory `aa73463cb6219ea52d6c779b8dfc1673ff613ae12852f2a1b06cb9e278e661e0`. Its numeric spec was authored under separate authority and has Main's scoped review, but no Astra final implementation approval or execution. The earlier `8114dcc2…` run remains 27 attempts, 26 passed, 1 failed. Its later inner GC scenarios were not reached, and its complete evidence remains preserved.

### Numeric correction retained

All three inverse-subtraction equalities are replaced with exact `gc.deadline === gc.sentAt + 30000` and original cycle/GC deadline equality. No tolerance or clock rounding is permitted. Keep the three independently scripted, advancing-clock witnesses: literal send/deadline `14982.969042/44982.969042`, timely phases under `1000.25/31000.25`, and final reply `31000.5` rejected against original `31000.25` although a renewed allowance from the later `3000.25` send would end at `33000.25`. Raw producer/client timestamps share one declared synthetic domain; actual transport time is not claimed from it. Preserve all original outer and inner cases, original 30-second native GC enforcement, strict replies, ownership, one wake, sticky failures and independent cleanup.

### Additional authoring scope

After explicit Main/Astra approval of the exact full v5 document and plan revision 8, a separate Main authoring GO may authorize the independent test author to edit only:

- `tests/cloudflare/helpers/worker-http.ts`: opt-in observation of existing owned HTTP requests, SlowStream physical closure, existing wipe witness retention support and the existing publication-client fetcher seam.
- `tests/cloudflare/capacity-realistic.spec.ts`: operation/phase evidence, existing wipe results, metrics observations, stream/held-request evidence and concurrent cleanup composition.
- `tests/cloudflare/capacity-admission.spec.ts`: retain its two existing wipe results and associated observation; no added reset or request.
- `tests/cloudflare/capacity-instrumentation.spec.ts`: one compact additive ownership/metrics observation witness group on top of the frozen numeric correction.

No product, `runtime/entry.ts`, `helpers/instrumentation.ts`, vendor, dependency, Inspector-command or other test-source change is authorized. Default unobserved helper consumers retain their behavior. Observation contexts are explicitly passed or captured per case/operation, never selected through a mutable global current-request variable. No global fetch interception is permitted.

### Evidence schema and finite retention

The observation context contains `version`, `caseId`, `caseNonce`, `limits`, `operations`, `metricsOperations`, `metricsAttempts`, `wipes`, `overflow`, `observerFailures`, `observedCounts` and `retainedBytes`. Every operation has its stable local `id`, `kind`, `label`, `phase`, `method`, safe pathname, optional encoding/declared length, acquisition/terminal outcome, cancellation intent, `events`, `errors` and physical closure outcome when that transport exposes it. Timestamps contain original epoch milliseconds and monotonic milliseconds, without global rounding or normalization. Changes of phase are recorded explicitly.

Each event records sequence, name and timestamp, independently of the helper's first logical terminal state. Each error records original source, `String(error)`, code when present, timestamp and the exact object-identity intentional flag where available. A true intentional flag requires the exact helper-owned error object. Being after cancellation, sharing a code/text or occurring in a nearby phase is not that identity check and does not classify an error as harmless. Do not replace the original error passed to existing consumers.

The fixed per-case caps are 1024 logical operations, 3072 metrics attempts, 64 lifecycle events and 32 errors per Node-owned operation, 4096 UTF-8 bytes for an error/string field, 4096 UTF-8 bytes per validated metrics result, 65536 UTF-8 bytes for a returned wipe witness, and 8388608 aggregate retained observation bytes. IDs/labels are at most 128 UTF-8 bytes. Wipe count is at most one for each of the two admission cases and five realistic cases. These are observation bounds, not altered application or polling limits.

Charge retained records before inserting them. Cap counters, overflow counts/first-overflow metadata and observer-failure status remain outside the capped arrays so exhaustion cannot conceal itself. On excess, retain an explicit failure and a bounded prefix with original byte count/hash where applicable; no truncated record qualifies as complete evidence. Observer callback failures must be retained without throwing through transport callbacks or skipping other cleanup. Any overflow or observer failure fails the affected case and remains visible to final review. Never retain authorization headers, credentials, full header collections or extra response-body copies.

### Node HTTP ownership and close joins

For observed Node requests, establish request error/close/socket listeners before `end`, `write`, `flushHeaders` or another fallible post-acquisition action. Establish socket error/close latches on the actual owned socket, including one already assigned. Establish response end/error/aborted/close latches before data consumption. Keep errors and events that occur after a logical end or another failure. Distinguish no acquired handle, acquired request without a socket, and an acquired socket whose closure is unknown.

Each observed SlowStream owns one idempotent close-join promise and original 3000ms deadline starting on its first owned destruction, including existing timeout/error destruction paths. A later finalizer reuses that promise/deadline; it does not destroy again merely to restart a budget. Actual already-fired close events count. A fully drained stream retains its complete-body terminal outcome if later cleanup records destruction. Never equate `destroyed`, response end, lease release, Inspector close or process exit with that handle's request/socket close.

Require actual request close and actual socket close when a socket was acquired; a complete-response witness requires its actual socket. A no-socket result is permitted only if no socket was acquired. Observe event time against the original deadline; a late event stays late and cannot rehabilitate an expired result. A destroy error must not skip the remaining safe close observation, request destruction or other acquired handles. Partial acquisition retains the original error and owned cleanup outcome before rethrowing or reporting failure.

The original four concurrent stream cancellations remain consecutive without an awaited join between them. Record intent before destruction. Start their joins at those existing cancellations, but do not await them before the original cancel-in-progress heap sample or change polling cadence. Keep acquisition, eight held bodies, ninth refusal, four complete drains, four cancels, live heap/RSS/lease/GC phases and full recovery/body expectations in the original workload order.

On every finalization path, including failure before measurement or acquisition completes, initiate all still-needed owned stream destruction/joins independently, alongside existing profiler and GC-HTTP pre-close cleanup. Collect all settled results, preserve every primary/secondary failure, then attempt the separate Inspector close even if another cleanup failed. The real concurrent composition must be `max(12000,3000,3000)+5000 = 17000ms` of configured pre-close/Inspector-close allowances. Awaiting a new serial 3000ms streams step before starting profiler cleanup is not compliant. Existing pending-drain outcomes still settle and remain recorded; concurrency in cleanup must not erase them. No fresh per-finalizer/per-handle retry budget, changed 30000ms GC limit, or changed 1800s case/7200s check bound is permitted.

### Existing wipe and held-upload observations

Retain the WipeWitness already returned by all seven existing wipes, including nonce, abortError, before/prepared/after state, verified fields and case association. Preserve a hook/acquisition failure when no witness is returned. Issue no added wipe, GET or state probe. Any claimed request/socket closure for the existing Node wipe request comes from the same early event latches and one bounded owned join; logical reset verification alone is not a socket receipt. Retain evidence even if a beforeEach hook fails.

The three held PUTs retain their original 401/Bearer,409,409, zero sent-body expectations, exact owned intentional-error identity rule, original 3000ms joins and independent cleanup. Add stable operation labels and original event timestamps only. The authenticated recovery GET still occurs only after all three actual closes and must return status200 with the complete exact null-head/null-manifest object.

### Metrics transport and reporting-trace identification

The existing metrics calls use `contractClient/createPublicationClient`, not Node rawRequest. Use the already available `createPublicationClient` `fetcher` injection, exposed by an optional test-helper argument if needed. Scope the observer to the existing metrics calls in the eight-stream case. Preserve the original authentication, method, headers, bodylessness, original RequestInit/signal, 90000ms per-attempt timeout, existing retry/wait policy, complete bounded body consumer and schema validation. Do not replace the transport with rawRequest, add calls, or change polling cadence.

Each existing logical metrics call gets a local operation ID and each existing fetch attempt gets a separate counter. Record attempt start, response-header/status arrival or the original thrown error, separately from the enclosing metrics call's validated result/error and consumer-settlement time. Delegate exactly once per existing attempt to the real fetch with the same init/signal; return the identical Response object and rethrow the identical original fetch error. Do not read, clone, tee, replace or wrap its body. Failed attempts remain visible even if an existing retry later succeeds. A successful logical consumer settlement is not a per-attempt body-end or socket-close receipt.

For those same local metrics attempts only, append query key `__orbit_capacity_op` with value `s82.<nonce>.m<operation>.a<attempt>`. The nonce is exactly 12 lowercase hexadecimal characters, operation is 1–1024 and attempt is 1–3; the bounded value is nonsecret and unique within the recorded case. Use the exact owned configured local origin and pathname `/__orbit/publish/metrics`; never add the tag to another origin/path or a production request. Preserve existing query components other than refusing an unexpected duplicate reserved key. Record the actual tagged URL. The controlled witness uses explicit literal nonce/ID expectations rather than computing expected results through the tag implementation.

Version-pinned worker-entrypoint records the full request URL in FetchEventInfo, and tracer emits it in the NOSENTRY warning; product forwarding/routing preserves it and routes by pathname. A literal recognized tag therefore identifies the reporting metrics invocation/attempt if the warning occurs. No warning is required as a success oracle. Missing/truncated/unrecognized event info remains unresolved; do not reconstruct a marker from chronology. The marker does not identify the originating background task or map native exception IDs to streams. Undici/fetch exposes no per-request socket through this interface, so no such physical-close claim is made for metrics.

### Independent witness and actual diagnostic acceptance

Add one compact witness group using literal payloads and independent producer/owned-close events for normal complete-body closure, cancellation/early-error preservation, partial acquisition as applicable, and one unconfirmed close that does not prevent another acquired handle from receiving cleanup. Verify original error retention and idempotent deadlines. Include the metrics seam's original init/signal, identical Response/error, only permitted local query change, no added body consumption, actual status and ordinary consumer completion. Retain all 27 prior outer cases and all prior inner cases, including the three new numeric rows. The resulting 28 outer declarations are static until executed.

Retain every actual native exception with its original identity, timestamp and context, separately from later replays. No error count, passed-test count, timing proximity or fixed two-errors-per-cancelled-stream ratio is an acceptance oracle.

The existing narrow C5 qualification remains available only for the evidenced three withheld-body rejection episode with expected complete responses, zero uploads, all bounded physical client closes and exact recovery. Its exact native emitting layer/pump instance remains unobserved. It is not a global request-stream warning exception.

For cancellation/network/metrics diagnostics, Main and Astra must review the complete actual episode against direct per-owned-stream lifecycle/error/close records, unchanged body/lease/recovery oracles and the version-pinned source mechanisms: generic untunneled KJ DISCONNECTED conversion, rejected original producer waitUntil completion, actor-shared asynchronous logging and heuristic current-request trace attribution. The recognized query tag attributes a warning to the reporting metrics attempt and its actual recorded outcome only. It does not prove that metrics handler caused the background failure or that NOSENTRY implies outcome OK. No per-native-ID-to-stream mapping, exact native emitter or global resource-freedom claim is permitted.

A narrowly worded native limitation requires explicit Main/Astra review of the actual final-source artifacts; it is not preapproved by this design. Wrong responses, body/lease/recovery failures, unknown or late owned closure, observer/retention failure, unexplained errors or continued diagnostics outside the evidenced episode remain failing/unresolved. No native text is filtered, no rejected product waitUntil promise is suppressed, and no current failed execution is relabelled as passed.

### Verification and progression

Plan revision 8 rebinds this full document and amendment only. All 19 check definitions, order, commands, environment, ports, deadlines, network/remote limits and original numerical acceptance criteria remain identical to revision 7. After exact combined-source Main/Astra implementation approval and a separate independent-executor handoff, run all 15 ordinary local checks freshly in canonical order: root types, full unit, default build, Worker types, Cloudflare build, dry-run, Worker contracts, CLI contracts, full Worker UI, full capacity, controls, local remote-transport/browser guards, full83-file production and exact18-file development E2E. This replaces only the preceding conditional carry suggestion for this changed shared helper; do not reuse an old failed capacity result.

Only the unchanged installation/browser prerequisites may retain their existing explicit input-bound proof after final review. Both remote checks remain deferred until actual authorized deployment and collection. Stop after failed/incomplete checks, preserve all evidence, and reconcile before further dispatch. No direct, narrowed or separate diagnostic runtime/probe is authorized. Design agreement, final-source agreement, actual local pre-deployment acceptance and actual remote/scheduling acceptance remain distinct exact-hash stages. Preserve root Stage81 work, protected local data, all historical failures, the missing blocked Astra review and user-directed Fable exclusion.

## Remedy06: bounded process observations and complete cooperative content checks

This amendment concerns test instrumentation only. The exact source 5bd6ea0e078944c261689b102453141831bf1018a9224865ca2a4e7963d5ba63 completed worker-capacity-d5f0cec871b8 with 27 passes and one failed mandatory RSS interval. Preserve that result and every original observation. Empty output with callback code0 is not proof that workerd died. The retained parent-observed 31.262-second command interval, pinned Node source and long synchronous assertions support a bounded acquisition-hardening proposal; they do not establish this run's unique timer/pipe/exit ordering or exact root cause.

### Scope and unchanged acceptance

The independent test author may change only tests/cloudflare/helpers/instrumentation.ts, tests/cloudflare/capacity-instrumentation.spec.ts and tests/cloudflare/capacity-realistic.spec.ts after exact design agreement and a separate authoring handoff. Main promotes the agreed design and plan. Product, collector, packages, controls, HTTP helper, admission suite and configuration remain unchanged. Retain all28 outer declarations in their original order, all22 ordered-GC rows and all4 held original-deadline rows. Do not add a narrowed check or diagnostic runtime.

All130 companies,6500 jobs,3500-character descriptions and90 days, every existing content/identity/duplicate/length/schema/freshness assertion, full encoded and decoded body checks, profile boundaries, request clocks, lease/cancellation/recovery workloads, sampling interval, one-in-flight policy and invalid-interval rejection remain. The previously agreed finite HTTP observation limits, native diagnostic acceptance, cleanup contracts and original numeric product limits remain unchanged.

### Original command deadline and truthful provenance

Keep the same single execFile producer and its registered child. Add observation only: command sequence, exact permitted argv, positive child PID when known, existing parent/run identity without extra I/O, wall/monotonic invocation and callback times, and bounded exit/close/error and stdout/stderr data-count/end/close/error states. Fixed-size fields and counters replace any proposed event/chunk history; retain no extra copy of stdout/stderr and capture no environment or secrets. Error/argument metadata strings are bounded to4096 UTF-8 bytes with original/retained byte lengths and explicit truncation where applicable; absent values stay null/unknown, not fabricated0. Existing command outputs retain their current16MiB execFile bound and any truncation/error provenance. When data handlers receive decoded strings, label their byte totals as observed decoded UTF-8 counts, not original pipe bytes.

The adapter must observe the existing child/streams without consuming a second stream, replacing the producer, adding a timer/kill/wait, changing execFile listener ordering or extending ownership. Node may invoke its callback from an earlier close listener before a newly attached close observer; capture callback-time facts separately from later observed lifecycle state, without inventing an early close or losing the original failure. A bounded holder may retain later observations for final evidence; exactly one command result is settled. Observer failures remain separate recorded failures and cannot throw unhandled, erase the primary error or confer success. Unknown event ordering is not fabricated missing-close proof.

Every actual execBounded acquisition retains an unrounded monotonic start, the original deadline start+timeoutMs, and callback observation time captured immediately on callback entry. Keep the existing default5000ms timeout, SIGKILL,16MiB maxBuffer and TZ/LC_ALL environment. Callbacks at or before the original deadline may be evaluated normally; a callback after it is invalid even when code0 and errornull arrive before a delayed timer callback. Never renew the deadline, round elapsed time before comparison, extend a timer to rehabilitate a result, issue a hidden retry or accept late nonempty output. Existing listeners/process ownership consumers must also reject unavailable/late command evidence.

Preserve raw stdout/stderr, actual callback error/code/signal/killed facts and any directly observed returned-child termination flag separately from the command validity decision. Unknown native timeout/stream/OS-exit ordering remains unknown. A child flag or callback absence must not be re-described as proof of successful physical termination. An explicit acquisition-deadline diagnostic may coexist with a retained raw code0; the normalized result must not make an unavailable acquisition look usable. Numeric nonzero exits retain their current meaning only when command acquisition itself is valid. Preserve earlier errors and exactly one settled result. No product promise or runtime error is suppressed.

Memory sampling records dispatch phase/time separately from callback phase/time and preserves the legacy sample.phase completion-time meaning. A phase change while ps is pending is explicit in separate fields rather than retrospectively renaming the acquisition. Retain the original command evidence in every sample. Missing/malformed/changed process rows and failed, empty or late command observations remain unavailable/invalid; no absent RSS becomes0 and no invalid sample is removed or replaced. A valid-invalid-valid interval stays unusable. Preserve at most one pending sample, coalesced ticks and the existing bounded stop; do not pause/restart the sampler around assertions or create an extra replacement sample while one is pending.

### Complete content oracles with event-loop turns

Convert the long catalog, posting-status and observation-history assertion walks to awaited cooperative walks. Use a small fixed batch (16 items) and a real event-loop yield such as an awaited setImmediate between batches; Promise.resolve alone is insufficient. Apply the bound inside nested job loops, not merely once per company. Every item and field still receives the same assertions, in the same logical order, and errors propagate to the original test. Update and await every call site including retired-generation/survivor checks; preserve the parsed catalog return and all downstream assertions.

The helper is test-only. It must not swallow exceptions, schedule unawaited work, short-circuit remaining successful items, alter fixture sizes, introduce network requests or move profile/request-clock/lease acquisition boundaries. Complete schema validation and JSON parsing remain required. Yielding reduces monopolization by the repeated assertions; it does not assert that every individual synchronous operation or host scheduling delay will fit a deadline. Fresh full actual verification must establish a usable interval.

### Independent literal regression witnesses

Add controlled rows inside existing instrumentation groups without adding, renaming or skipping outer cases. Use an injected monotonic clock/command callback seam to cover a successful empty callback and successful nonempty callback just after a fractional original deadline while the timeout task has not dispatched; both are invalid. Also cover timely valid output, inclusive exact deadline, earlier failure preservation, raw code/error/signal provenance, no renewed deadline and single settlement. Literal numeric inputs are start1000.25, timeout5000, D6000.25, timely6000.0, exact6000.25 and late6000.5. Include callback-before-later-observer ordering, bounded observer failures, supplied stream close-without-end and late close after diagnostic settlement, clearly labelled as conditional sequences rather than reconstructions of the historical failure. Preserve literal numeric-exit1 empty versus rows/stderr, ENOENT, signal/kill, partial/output-overflow and changed-identity cases and their strict existing classifications. Expected numbers and outcomes are literal independent inputs, not calculated through the deadline implementation.

Retain sampling dispatch and callback phases through a controlled pending phase transition, and retain a late/empty invalid sample between valid samples as an unusable interval. Controlled fixtures must not invoke a real application, command, socket or probe outside the approved dispatcher.

For the cooperative walk, arrange an already pending owned event-loop callback and prove it is serviced before the walk finishes, with a literal expected complete visitation order. Include nested coverage and a deliberately wrong late item after a yield whose assertion error propagates unchanged. A counter that only repeats the implementation's batch formula is insufficient. No real sleep or relaxed numerical expectation substitutes for these witnesses.

### Exact-source verification and progression

Plan revision9 binds this full design amendment. All19 check definitions, order, command arguments, environment, ports, timeouts, remote/network rules and original acceptance text/criteria remain byte-for-byte structurally equal to revision8. After final combined-source Main/Astra implementation agreement and a separate tester GO, all15 ordinary local checks run freshly in canonical order and stop after any failed/incomplete check. The prior9 accepted results remain attached only to source5bd6; they do not carry as fresh tests of the remedy. Only the two unchanged installation/browser input-bound prerequisites may be rebound after explicit final input review.

The two remote checks remain deferred until authorized actual deployment and collection. Each new actual native episode needs its own exact-source Main/Astra qualification; the failed5bd6 run's bounded native limitation is no future allowlist. Preserve original failures, the blocked historical Astra review as missing, Fable's user-directed exclusion, root Stage81 changes and protected local data. Design approval does not approve implementation, execution, actual results, deployment or scheduling.

## Remedy07 amendment: owned sampling process, unchanged measurement acceptance

This is a proposed amendment, not source-authoring, execution, actual-result or deployment approval. Source87262574/designv6/plan9 capacity7165f42a ended27pass/1fail. Preserve the failed run and both original5s deadline violations; the first retained677 output bytes and the second retained none. Main's independent actual review is9a3a5b6313005db535816835db8cb6fbeee50069a8963a99b018c15942c8a1f2. The exact blocking operation and unique OS/internal timeout cause remain unproved. The purpose is to remove the scheduling dependence between full content validation and RSS acquisition, not to retrospectively rehabilitate the run.

### Scope and mechanism

The two existing realistic MemorySampler intervals run in one newly owned Node child per interval. Launch the checked-in test-only child entry using process.execPath and the existing --import tsx loader. Preserve the approved process-registration preload, registry, run and actor identity. Use the existing MemorySampler and execBounded implementation in that child; do not duplicate or relax the acquisition classifier. No new package, generated executable, eval, shell, network listener, endpoint, remote request or loader-private API is introduced.

The test-only write set is tests/cloudflare/helpers/memory-sampler-process.ts and tests/cloudflare/helpers/memory-sampler-child.ts (new), tests/cloudflare/helpers/instrumentation.ts only if needed for explicit owned cancellation/final observation interfaces, tests/cloudflare/capacity-instrumentation.spec.ts and tests/cloudflare/capacity-realistic.spec.ts. Product, collector, shared schemas, HTTP helper, admission suite, dependency manifests, configuration and validation controls stay unchanged. Main may integrate only the agreed design/plan and ordinary validation documentation. The independent tester authors this exact scope after a separate explicit handoff.

Keep all28 outer cases and their order, all22 GC rows,4 held-deadline rows,24 command rows and2 cooperative rows. Preserve the complete130-company/6500-posting/3500-character/90-day workload, every schema/field/duplicate/identity/freshness assertion, complete encoded/decoded byte comparisons, all profile/request-clock/lease/GC/heap/recovery boundaries and current product limits. The fixed16 awaited cooperative walks remain. Do not move a content assertion outside the measured workload or pause the sampling interval around a heavy assertion.

### Acquisition, phase and ownership protocol

The parent creates one fresh nonce-bound child session and installs error, exit, close, stdout/stderr and IPC observation before sending initialization. Only the exact previously bound runtime/workerd identities and the needed run/actor/source/plan identities cross the boundary. Do not transmit or record an environment dump or credentials. Retain acquired PID/parent/argv, startup/phase/stop messages and actual exit/close facts in bounded evidence. Startup must positively identify this returned child and its same-run registration; a port or unregistered process is never adopted.

Use an explicit versioned message protocol with session nonce, strictly increasing request IDs and exact operation kinds: initialize, phase and stop. Reject wrong nonce/version/identity, duplicate or out-of-order response, malformed data, unexpected operation, child error/exit/disconnect and missing response. One session is used once; no restart, replay retry or alternate child follows a failure. Startup and each phase acknowledgement have one original5000ms parent monotonic deadline, inclusive, checked at actual reply receipt even if a timer is late. Error and partial acquisition must retain the child handle and take the same unconditional bounded cleanup path.

A successful startup acknowledges that the child imported the existing sampler and began the250ms cadence before the first measurement workload begins. Await phase acceptance before starting each corresponding workload. Child dispatch/callback/completion use that child's own unrounded monotonic domain and the phase actually active there. Parent send/receipt and child acceptance times are retained as distinct domains; no subtraction between unrelated performance.now origins and no claim that parent message receipt is the command callback time. Preserve the sample.phase completion meaning and explicit dispatch/callback phases, including transitions while a ps command is pending.

Each actual ps acquisition remains one execFile with5000ms,SIGKILL,16MiB,UTC/C and the exact owned workerd PID set. Keep at most one acquisition in flight, coalesce cadence ticks and retain every result. Raw code/error/stdout/stderr, child and stream observations, one settlement, observer failure stickiness, strict identity and RSS validation, inclusive original deadline and invalid-interval rejection remain unchanged. A timely empty result still cannot manufacture RSS; a late successful result stays unavailable. The parent must independently re-run the existing summary usability qualification after receiving complete evidence. No valid-only summary, zero substitution, hidden retry or replacement sample is permitted.

### Complete bounded evidence and termination

Do not synchronously serialize a growing full summary while a command is pending. The child retains bounded per-command observations using the existing adapter. A terminal summary is sealed only after sampling stops and all acquired command/stdio observations are final or explicitly failed. A missing child/stdio close, unknown active command or later observation failure is a failure; sending a summary cannot make it disappear. Preserve all failures through sealing and through actual child exit.

The child writes one uniquely owned regular terminal JSON artifact with exclusive creation and private permissions under the parent-selected test output path. Return only its path, byte length and SHA256 through the bounded control channel. The parent checks the exact expected path, regular non-symlink file, length/hash, complete schema, run/session identities, original workerd set, sample counts and existing usability rules before incorporating it in the original capacity evidence. The raw artifact is preserved by the ordinary reporter/attachment preservation, including on failure. A report message or file alone is not success; actual child exit0, IPC closure and acquired stdout/stderr close must be observed, with no late failure or unexpected output. Bound control messages to64KiB, unexpected stdout and stderr to64KiB each, retained samples to8192 and the complete terminal artifact to128MiB. Any overflow is explicit failed evidence, never truncation into a passing result; retain the available raw evidence and the first overflow reason. These are diagnostic storage limits, not a Worker memory limit or reduced sample/workload count.

Keep existing MemorySampler.stop semantics exactly: the original6000ms in-flight join, then its existing final acquisition with its own original5000ms limit when eligible; no final sample while an earlier one remains pending. That existing method is not a single6000ms total-stop deadline. The new parent owner-finalization has one original15000ms budget from its first stop/cleanup request, covering those configured11000ms sampling waits plus evidence transfer and actual process/stdio/IPC closure. This new process lifecycle budget does not lengthen either acquisition or the in-flight join, or any case/check timeout. Repeated stop/cleanup returns the same promise and deadline. A timeout cannot be rehabilitated by a later close.

On startup/phase/stop/assertion/report failure, preserve the primary error and independently settle every acquired resource. A cancellation hook may stop future ticks and join/terminate only that sampler's retained command handles; it may not signal workerd, other children or a guessed/reused PID. Forced process cleanup may target only a positively rechecked owned child identity. Missing identity or unknown descendant closure is recorded and fails; do not report a killed flag as physical closure. Keep bounded error/close observation after a signal and preserve late events without changing the failed verdict. The approved outer dispatcher remains the final whole-run ownership check. No failure authorizes a replacement process or a narrowed rerun.

### Independent regression evidence

Add bounded rows within the existing instrumentation groups. Exercise the real owned child path under the approved full capacity check, including ordinary startup, acknowledged phase transition, sampling with exact owned identities, one successful stop and physical child/stdio closure. Include a controlled controller-busy interval to demonstrate that the child continues taking admissible observations independently; declare clock domains and the limited inference precisely, without pretending it proves the historical blocking operation.

Use independently supplied literal protocol producers/frames and close events to cover wrong identity/nonce, malformed/oversized or duplicate/out-of-order response, phase deadline exactly at and just after its original fractional boundary before timer dispatch, child exit/error before readiness, unavailable/invalid memory between valid samples, failed sealing or hash/size mismatch, lost/late close, repeated finalization identity and one failed owner not preventing another from cleanup. Preserve a later failure after an earlier successful-looking summary. Expected outcomes must be literal and independent of the implementation's guard/summary output. Include no external application, command or probe outside the approved dispatcher. Existing low-level24 command rows and their strict sample classifications remain mandatory evidence.

### Verification and progression

Plan revision10 binds the full v7 design. All19 check definitions/order/args/env/ports/network/timeouts/remote prerequisites and original acceptance text/criteria remain structurally byte-identical to revision9. After exact final-source Main/Astra implementation agreement and separate tester GO, all15 ordinary local checks run freshly in canonical order and halt on any failure/incomplete result or unresolved diagnostic/closure. Earlier8726 first9 consensus remains valid only for that source; its failed capacity is not waived. Only the two unchanged installation prerequisites may be explicitly rebound after exact input review. Both remote checks remain deferred until actual deployment and first collection. Every future native episode needs its own current-source review.

Preserve the blocked historical Astra final as unreceived, Fable's user-directed exclusion, root Stage81 work and protected local data. No design or implementation approval alone authorizes Git preservation as a completed stage, deployment, real collection, remote acceptance or scheduling.

### Concrete owner and wire refinements (R7-P1 through R7-P4)

These requirements resolve the independent test preparation b6e4081d4799bc20e1a14473c0b74983b75223f2e4db1a3596af25d2f7084557. They refine the proposal above without authorizing source changes or changing a product/check/acquisition limit. The original v7 candidate and Astra independent approval remain historical, not approval of this new hash.

**R7-P1 — startup and exceptional ownership.** Start the parent startup clock and original5000ms deadline before invoking launch. Pass the fresh nonsecret session UUID to the child at launch. The child installs its message handler after importing the shared sampler and emits one control-ready announcement before the parent sends its single initialize request. This announcement is an initialize substate, not a fourth operation or retry. A native spawn event, an IPC send callback, or control-ready alone does not mean sampling has started. Success needs the correlated initialize acknowledgement, cadence active, exact returned-child PID/parent plus same-run registration, and all startup qualification completed by the original deadline. All receive times are captured at callback entry; later timer dispatch cannot accept a late reply. No workload starts before successful startup and the requested phase acknowledgement.

The unchanged registration preload performs a synchronous append after native launch. If that producer/preload throws before returning a child handle, classify acquisition/ownership as unknown and failed, retain the original exception, do not guess or signal a PID, and await the approved outer dispatcher ownership result. Do not claim a retained handle or timely local closure in that branch. This explicit exceptional failure boundary needs no controls modification. Any normally returned handle is retained and unconditionally finalized even when initialization or later qualification fails.

**R7-P2 — opt-in command lifetime and plain terminal facts.** The instrumentation.ts change is required and limited to opt-in lifetime/cancellation/final-observation interfaces. The ordinary execBounded producer, callback settlement, listener ordering, default waits/kills and all24 existing literal outcomes remain unchanged. Register an opt-in lease for every attempted acquisition, retaining only its actual returned command handle and acquired stdio; the lease includes the final sample, which cadence pendingSample() alone does not cover. A producer/observer failure stays separate and sticky. Cancellation stops future cadence without creating a new final or replacement sample on an already failed owner path; it may act only on retained live command handles and must observe their actual terminal events or record failure.

The new parent owner caches one finalization promise and its first deadline. Concurrent or repeated calls return that exact same promise; do not delegate this guarantee to the existing async MemorySampler.stop(). Invoke the original sampler stop at most once on the normal path. Command callback resolution is not a terminal-observation barrier. Wait for each acquired command exit/close and acquired stream terminal observations, including observers delivered after callback settlement, or preserve explicit failed/unknown terminal state. All observations remain live until sealed; convert getters/holders into a complete plain snapshot only at that boundary. Validate serialized timing, flags, counters, raw result and identity consistency rather than trusting a supplied usable:true. The parent applies the existing summary qualification to all received samples and cannot accept a valid-invalid-valid interval. Later child/observer/output/protocol failure after a provisional terminal report invalidates the owner through observed physical exit, even when the sealed file itself says usable:true. Retain the file and the later failure; never rewrite the file as though the failure occurred earlier.

**R7-P3 — escalation within the original owner deadline.** Let T be the first parent owner-finalization entry and D=T+15000, unrounded. Normal child sampling keeps the existing6000ms in-flight join and eligible final5000ms acquisition. Stop response, safe artifact verification, child/IPC/stdio closure and any owned descendant qualification must all finish by D for success. Child component clocks are independent; they do not replace or renew D. Reserve the last3000ms for exceptional ownership/termination observation: at T+12000, if normal owner finalization is still incomplete, mark a sticky failure and begin ownership-checked escalation. After a fresh positive identity check, request SIGTERM only for the retained sampler child and its positively identified same-run sampler/loader descendants that remain live. At T+13500, if still required, freshly recheck identity and request SIGKILL only for those same owned identities. Every recheck and wait uses only the time remaining to its next cutoff and D; no fresh post-expiry kill/join budget is added. A cutoff reached during a recheck does not authorize a late signal. A missing/reused/mismatched identity is failed/unknown ownership, never a signal target. Never signal workerd, a shared process group, a replacement PID or an unrelated child.

Track sampler-owned command leases separately from loader descendants; neither Node exit, unref, a library stop return nor killed:true is physical descendant closure. Preserve original PID/parent/birth/command and same-run registration for any descendant later checked or signalled. A process that was already observed closed is not signalled. If a loader service cannot be attributed or closed under this contract, fail and retain the limitation; use no private loader API or controls change. The outer dispatcher still performs its independent final whole-run sweep, but its later result cannot turn an untimely/unknown local owner into a timely successful owner. Actual late exit/close events remain evidence without changing the already failed verdict. Exceptional no-returned-handle acquisition stays explicitly unknown as described in R7-P1.

**R7-P4 — exact control envelope and bounded storage.** Use native Node IPC with application-level JSON string payloads. Check a sent or received string's Buffer.byteLength(value,'utf8') against65536 before application JSON.parse; reject nonstring payloads. This is an application payload cap, not a promise that Node's native IPC pre-deserialization allocation is bounded to65536. No such stronger wire claim is made.

Each decoded envelope has exactly version:1, session:<canonical UUID>, sequence:<positive safe integer>, requestId:<nonnegative safe integer>, kind, operation, senderPid:<positive safe integer>, at:{epochMs:<finite valid Date ms>,monotonicMs:<finite nonnegative number>} and payload. Reject extra envelope keys. sequence increases by exactly1 in each sender direction and is independent of the correlated requestId. For a parent request, requestId equals that request's sequence. Only one parent request may be outstanding. The operations remain initialize,phase,stop. The allowed combinations are: parent kind=request with one of those operations; child kind=ready with operation=initialize and requestId=0 exactly once; child kind=ack for initialize or phase with the pending requestId; child kind=terminal for the single stop request; and child kind=fatal to retain an asynchronous failure for the current/last request (requestId=0 only before initialization). fatal is never success or a retry and may invalidate a provisional terminal. Other kinds, duplicate sequence/request responses, gaps, wrong operation/session/PID or unsolicited successful replies fail. A fatal notice after a terminal is a separate strictly sequenced failure notice, not a second successful stop response.

Initialize payload is a closed record of the exact run,actor,sourceDigest,planSha256,validated plain OwnedRuntime snapshot,expected absolute terminal artifact path and the fixed cadence250. Child acknowledgement binds those identities and reports cadenceStarted:true with its acceptance timestamp. phase payload is exactly {phase:<nonempty string,at most128 UTF-8 bytes>}; acknowledgement echoes the exact phase and child acceptance timestamp. stop payload is exactly {cancel:<boolean>}; cancel is allowed only for an already failed owner and cannot recover it. Terminal payload is exactly {path,bytes,sha256,complete:<boolean>}; a complete:false artifact or any fatal message always fails acceptance. Ready payload names controlReady:true and the actual parent PID. Fatal payload contains the bounded original failure description and the stage at which it was observed; no environment or secret dump. Producer timestamps are retained as producer data, alongside independent parent send/receive observation; they do not qualify parent deadlines by themselves.

Retain at most64 control frames and262144 UTF-8 payload bytes per direction, including unexpected frames up to those bounds. Keep original/retained byte counts and the first overflow reason. stdout and stderr retain at most65536 bytes each and any unexpected output fails; metadata descriptions remain bounded to4096 UTF-8 bytes with explicit original length/truncation. Do not let diagnostic event/error history grow without a bound.

The terminal artifact is a version1 closed envelope containing the session/run/actor/source/plan bindings, parent/child identities and clock domains, startup/phase/stop evidence, the original complete MemorySummary, opt-in command lifetime evidence, owned resource/descendant closure, complete and failures. The original MemorySummary and observation field shapes remain the baseline exported types; implementation adds strict JSON-safe schema and cross-field consistency checks for the actual process-backed mode. A failure envelope may preserve bounded partial observations with complete:false, but can never pass qualification. Parent validation must confirm every expected workerd identity/role, phase provenance, raw command/timing/validity consistency, sample and invalid-sample counts, retained observation bounds, and all original usability requirements. Unknown/missing required facts fail; no original field is defaulted into success.

Enforce8192 retained samples and134217728 terminal UTF-8 bytes using incremental per-record accounting with reserved bounded terminal metadata. Do not retain an unrestricted growing list and discover the cap only after whole-summary JSON.stringify. A completed record can be finalized/accounted separately; only one bounded command result may remain unfinalized, under its existing16MiB output limit and bounded observer metadata. Any conservative reservation, final observer growth and JSON escaping overhead must be accounted explicitly. Do not serialize the growing complete summary while a command is pending. If adding a record cannot fit, stop new sampling on the already failed cancellation path, preserve the first overflow reason, original/retained sizes and available bounded evidence, and fail. No truncated or omitted record contributes to a passing interval. These limits bound diagnostic retention and artifacts, not every temporary JS allocation or provider isolate memory; no stronger memory claim is made.

Create the one expected artifact exclusively with0600 permissions at the parent-chosen unique output path. Seal once; do not overwrite an existing file. A terminal path mismatch is rejected before reading or attaching that path. Open the expected path through one read-only no-follow handle, require a regular private file, record descriptor identity (device,inode,mode,size and available high-resolution times), bound reads to the declared limit, verify actual bytes/SHA256/JSON schema and recheck stable descriptor metadata after reading. All qualification occurs by D. A symlink, swapped/changed file, missing/trailing/oversized data or mismatch fails. Never preserve a rejected arbitrary path by reading it; retain the received bounded frame and failure metadata instead. Only verified expected artifacts or safely opened expected partial failure artifacts may enter reporter preservation.

Implement meaningful independent witnesses for each refinement, including readiness ordering, no-returned-handle failure without guessed signal, final-sample lifetime and late observer mutation, exact cached finalizer promise, original12s/13.5s/15s cutoff behavior, unchanged/reused/unconfirmed descendant identity, wrong/malformed/oversized/out-of-order IPC, cumulative and sample/artifact overflow, symlink/path/hash/stability rejection, complete versus partial terminal evidence, late failure after provisional success and physical closure. The test preparation's17 witness rows are an authoring map, not executed results or a permission to weaken the preserved28/22/4/24/2 coverage. Deterministic expected values and producer actions remain independent of the implementation's own validators.
