# Cloudflare에서 운영하기

배포 대상은 `https://job.hyunjun.workers.dev`입니다. 정적 화면과 저장된 공개 공고를 Workers에서 제공하고, 별도 GitHub Actions 예약 작업이 공고를 수집합니다. R2나 Containers를 사용하지 않습니다.

이 문서는 운영 방법을 설명합니다. 실제 배포·검증 결과와 배포한 커밋은 단계별 검증 기록에 별도로 남깁니다. 설정 파일이 존재한다는 사실만으로 배포나 검증이 완료된 것은 아닙니다.

## 사용자가 보는 동작

- 처음 열기와 새로고침은 마지막으로 발행된 자료를 읽습니다. 지구 이동·검색·도시 선택은 수집 완료를 기다리지 않습니다.
- 예약 시간은 매시 17분과 47분입니다. GitHub Actions의 예약은 지연되거나 누락될 수 있습니다. 회사별 수집 간격과 실패 후 대기 시간도 적용되므로, 매번 모든 출처를 새로 수집하는 것은 아닙니다.
- 정상 확인 후 일반 게시판은 30분, Himalayas와 회사 사이트 직접 수집은 24시간부터 이전 조회로 표시합니다. 모든 출처의 공고는 마지막 정상 확인으로부터 정확히 24시간까지 표시하고, 그 이후에는 추천에서 제외합니다.
- 게시 목록과 본문은 각각의 확인 시각을 사용합니다. 본문의 확인 기간이 지나면 저장한 원본과의 비교를 최신 확인처럼 표시하지 않습니다.
- 관측 기록은 표시 중인 공고와 같은 자료 버전에서 읽습니다. 해당 버전이 정리됐다면 이전 기록을 비우고 공고 새로고침을 안내합니다. 관측이 없는 날을 0개로 채우지 않습니다.
- 개인 프로필·이력서·저장한 공고·메모·검색 조건은 발행 API에 보내지 않습니다. `localhost`와 `workers.dev`는 브라우저 저장 공간이 다릅니다. 기존 저장 공고는 JSON 백업을 내보낸 뒤 새 사이트에서 가져올 수 있습니다.

## 구성

`worker/index.ts`는 API 경로를 하나의 `CatalogStore` Durable Object로 전달합니다. 다른 경로는 Workers Static Assets가 처리합니다. 배포용 Vite 결과는 `dist-cloudflare/`이며 로컬 Express용 `dist/`와 분리되어 있습니다.

Durable Object의 SQLite에는 현재·이전 자료 버전, 발행 대기 상태, 최대 1 MiB씩 나눈 압축 청크가 있습니다. 각 논리 조각은 독립적인 gzip 스트림입니다. 공개 응답은 필요한 조각을 하나씩 해제하고 JSON 구분자와 함께 전송합니다. HTTP 응답의 gzip/br 압축은 바깥 Worker에서 적용합니다.

초기 청크 테이블은 `(owner, idx)` 기본 키와 `WITHOUT ROWID`를 사용합니다. 이 초기 스키마의 배포는 새 SQLite namespace를 전제로 합니다. 배포 직전 대상 Worker의 상태를 다시 확인하고, 배포가 만든 실제 namespace ID를 기록합니다. 기존 또는 출처가 불명확한 namespace가 있으면 데이터를 보존하는 이전 설계를 먼저 마련합니다. `CREATE TABLE IF NOT EXISTS`는 기존 테이블 구조를 바꾸지 않습니다.

조각 해제는 pako의 저수준 gzip 디코더로 한 번에 최대 64 KiB를 만든 뒤 소비자를 기다립니다. gzip 헤더·CRC32·원래 크기, 단일 스트림의 끝, 압축·해제 SHA와 예상 바이트 수를 검사합니다. 출력 버퍼 제한과 별도로 실제 런타임 전체의 메모리·CPU를 검증합니다.

공개 catalog, 게시 여부·본문 비교 자료, 관측 기록, 비공개 수집 체크포인트가 하나의 커밋으로 묶입니다. 업로드 중에는 현재 자료를 계속 제공합니다. 모든 청크와 예상 부모 버전을 확인한 뒤 짧은 SQLite 트랜잭션으로 포인터를 교체합니다. 빠진 조각을 다른 버전에서 가져오지 않습니다.

체크포인트에는 회사별 마지막 정상 snapshot뿐 아니라 목록 상태, 실패·재시도 정보, 최대 네 관측 묶음의 전체 기록이 포함됩니다. 다음 수집은 정확한 현재 체크포인트의 크기·해시·스키마·구성 ID를 검증한 뒤 이어서 진행합니다. 파일을 읽지 못하면 빈 상태로 재시작하지 않습니다. 회사 구성이 정상적으로 바뀌면 같은 회사/provider/board/region만 재사용하고 새 회사는 기존 정책에 따라 수집합니다.

수집기는 전용 인스턴스에서 목록 pass, 본문 pass를 한 번씩 실행합니다. `force=false`와 기존 회사별 대기·backoff·동시성 정책을 적용합니다. 공개 응답을 내보내기 위해 다시 수집을 시작하지 않습니다.

## 배포 준비

Node 22.12 이상과 고정된 `package-lock.json`을 사용합니다. Worker 관련 버전은 `wrangler` 4.147.0, `@cloudflare/workers-types` 5.20261003.1입니다.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run check:worker
npm run build
npm run build:cloudflare
```

이 명령들은 단위 검사와 빌드를 실행합니다. 단계 완료에는 별도로 독립 담당자의 E2E와 배포 환경 확인이 필요합니다. 검증 도중의 산출물은 `.local/`에 보관하고 검증 기록을 Git에 보존한 뒤 정리합니다.

`wrangler.jsonc`는 `job`이라는 Worker와 SQLite Durable Object의 선언적 `exports` 설정을 사용합니다. 이 설정에 별도의 `migrations`를 섞지 않습니다. API와 비공개 발행 경로는 정확한 루트 및 `/` 경계를 포함해 Worker를 먼저 실행합니다. API 오류를 SPA HTML로 바꾸지 않습니다.

정적 파일에는 보안 헤더를 적용하고, `/assets/*`만 장기 immutable 캐시를 사용합니다. 다른 정적 파일은 Static Assets의 기본 재검증 정책을 사용합니다. 자산 고지는 `/legal/attributions.md`, 번들 라이선스는 `/legal/bundled-licenses.md`에 포함됩니다. 프로젝트 전체의 새 라이선스는 선택하지 않았습니다.

## 발행 인증과 예약 설정

32바이트 이상 난수로 만든 전용 토큰을 사용합니다. 토큰은 Worker의 `PUBLISH_TOKEN` secret과 저장소의 `ORBIT_PUBLISH_TOKEN` Actions secret에 동일하게 등록합니다. Cloudflare 계정 OAuth/API 토큰을 수집기에 넘기지 않습니다.

토큰은 코드·Git·URL·Vite 변수·명령 인수·실행 로그에 넣지 않습니다. 초기 등록에는 권한 0600의 임시 secret 파일과 표준 입력을 사용하고 등록 후 파일을 삭제합니다.

최초 배포에는 검증한 Worker 산출물에 `--no-bundle`과 `--secrets-file`을 함께 지정해 발행 secret을 같은 버전에 등록합니다. 계정 ID를 명시하고 실제 배포 버전과 `CATALOG_STORE`의 namespace를 확인합니다. 예약 비활성 상태를 workflow 반영 전부터 유지하며, 첫 수집과 독립 운영 검증을 마친 뒤 활성화합니다.

저장소 변수:

| 이름 | 값 |
| --- | --- |
| `ORBIT_COLLECTOR_REF` | 검증을 마친 수집 코드의 전체 Git 커밋 SHA |
| `ORBIT_COLLECTION_ENABLED` | 초기 배포 확인 전 `false`, 확인 후 `true` |

워크플로는 검증된 SHA를 checkout하고 `contents: read` 권한으로 일반 `ubuntu-latest` 실행기를 사용합니다. checkout/setup-node는 전체 커밋 SHA로 고정합니다. 실행은 같은 concurrency group에서 직렬화하며 진행 중 작업을 취소하지 않습니다. 시간 제한은 25분입니다.

수동 실행의 `operation`은 `collect` 또는 `rollback`입니다. 예약 활성화 여부와 별개로 수동 실행이 가능하므로 최초 발행과 운영 복구에 사용할 수 있습니다. 워크플로에는 공고 원문 artifact/cache를 업로드하는 단계가 없습니다. 임시 복원·발행 파일은 종료 시 정리합니다.

수집 CLI는 깨끗한 Git checkout에서만 발행합니다. 수집 출처와 실행 코드의 커밋을 연결하기 위해 수정 중인 작업 폴더의 발행을 거부합니다. 목적지는 위 Workers 주소 또는 8787을 제외한 로컬 검증 주소만 허용합니다. 인증된 요청의 redirect를 따라가지 않습니다.

## API와 상태 확인

| 경로 | 용도 |
| --- | --- |
| `GET /api/catalog` | 현재 사용 가능한 공고와 회사별 조회 기록 |
| `GET /api/posting-status` | 목록 확인·본문 비교 메타데이터 |
| `GET /api/observations` | UTC 날짜별 관측 기록 |
| `GET /api/health` | 현재 자료 버전과 사용 가능 게시판 수 |

세 자료 API는 `generation` query로 보관 중인 UUID v4 버전을 지정할 수 있습니다. 대소문자는 허용하고 응답은 소문자를 사용합니다. 잘못되거나 중복된 값은 400, 정리된 버전은 410입니다. 선택한 버전은 `X-Orbit-Generation`에 표시합니다. 자료 버전을 지정해도 현재 시각에 따른 만료 판단은 계속 적용됩니다.

성공 API는 `private, no-cache, must-revalidate`와 약한 ETag를 사용합니다. 만료 여부를 먼저 판단하므로 만료된 공고에 오래된 ETag로 304를 주지 않습니다. `HEAD`와 304는 큰 본문 조각을 읽지 않습니다. hosted catalog는 `Prefer: respond-async`에도 저장된 완성 자료를 응답하며, progressive API는 404입니다. 로컬 Express의 수집·progressive 동작은 유지됩니다.

health 응답의 `ready`는 사용 가능한 게시판이 하나 이상이라는 뜻입니다. 전체 출처가 성공했다는 뜻은 아닙니다. 최초 운영 배포 완료에는 별도 기준인 130개 중 115개 이상의 최근 정상 게시판, 실제 공고, 유효한 목록·관측 자료를 확인해야 합니다.

`/__orbit/publish` 전체는 Bearer 인증을 먼저 확인합니다. `/head`, `/checkpoint/{boards|presence|observations}`, `/begin`, `/chunks/{generation}/{index}`, `/commit`, `/rollback`, `/metrics`가 운영용 경로입니다. 공개 API는 임의 청크나 비공개 체크포인트를 조회할 수 없습니다. `/metrics`의 SQL 행 수·버퍼 계수는 해당 DO 인스턴스의 관측값이며 Cloudflare의 CPU·메모리 측정을 대신하지 않습니다.

## 실패와 복구

수집 실패는 회사별 마지막 성공·실패 시각과 함께 보존합니다. 발행 실패는 현재 커밋을 덮어쓰지 않습니다. 현재 자료는 실제 시각에 따라 이전 조회 또는 만료로 바뀝니다. 최초 수집에서 모두 실패한 경우도 실패 상태 자체는 발행할 수 있으나 catalog는 503이며 배포 완료 기준을 충족하지 않습니다.

발행 대기는 마지막 접근 후 15분 또는 시작 후 2시간에 만료됩니다. 같은 generation/index/hash/크기의 업로드와 완료 확인은 멱등입니다. 다른 내용·부모 버전 불일치·누락 청크는 거부합니다.

완료 응답이 끊기면 수집기는 같은 generation·부모·자료 내용의 현재 head를 제한된 횟수로 확인합니다. 확인할 수 없으면 실패 종료하고 `COMMIT_UNCONFIRMED`를 기록합니다. 오류 로그의 `published`는 확인된 발행이면 `true`, 발행 시도 전 실패이면 `false`, 시도 후 미확인이면 `null`입니다. 미확인 상태를 미발행으로 단정하지 않으며, 함께 남긴 `attempted` 정보로 추후 확인할 수 있습니다.

현재·이전 커밋은 보관합니다. 그 밖의 커밋은 은퇴 후 5분 이상 지났고 사용 중인 응답이 없을 때 정리합니다. 응답은 처음 선택한 generation을 끝까지 사용하고 종료·취소·오류 시 사용 표시를 해제합니다. 복구 커밋이 참조하는 청크도 참조가 남아 있는 동안 유지합니다.

자료 rollback은 이전 **공개 자료**와 최신 **비공개 수집 체크포인트**를 새 커밋으로 발행합니다. 새 발행 시각과 원본의 수집 시각은 구분하며, 오류·backoff·누적 관측 상태를 과거로 되돌리지 않습니다. 코드 rollback은 저장 형식이 호환되는 검증 버전을 사용합니다. Worker 또는 Durable Object를 삭제하는 방식으로 복구하지 않습니다.

## 무료 범위와 한도

설계는 Workers와 SQLite Durable Objects의 무료 범위에 맞췄습니다. 계정 전체의 실제 요금제와 다른 앱 사용량까지 보장하는 것은 아닙니다. 이 배포를 위해 R2나 유료 Containers를 활성화하지 않습니다.

| 항목 | 애플리케이션 상한 |
| --- | --- |
| 압축된 자료 버전 | 64 MiB |
| manifest | 512 KiB |
| 청크 | 1 MiB |
| 해제된 catalog / posting-status / 관측 | 128 / 64 / 16 MiB |
| 비공개 board / presence / 관측 파일 | 128 / 64 / 16 MiB |
| 큰 본문 동시 전송 | 8개, 체크포인트 다운로드 포함 |
| DO 압축 payload 합계 | 512 MiB |

SQL 부가 공간을 포함한 저장 크기도 별도로 제한합니다. 큰 본문 제한을 넘으면 `CATALOG_BUSY` 503과 `Retry-After: 60`을 반환합니다. 작은 health 응답·HEAD·304는 이 제한에서 제외합니다.

Workers Free의 요청 CPU·요청 수, DO의 CPU·행 읽기/쓰기·duration·저장 용량은 각각 별도 제한입니다. 실제 자료의 크기·요청 수·SQL 비용·압축 응답·동시 전송·CPU/메모리는 초기 운영에서 측정하고 결과를 기록합니다. 방문량이 늘면 저장량보다 API 요청과 행 읽기가 먼저 제한에 도달할 수 있습니다.

GraphQL의 `cpuTime*` 값은 마이크로초이고 `memoryUsageBytes*`는 바이트입니다. Worker의 invocation 통계와 DO의 invocation·periodic 통계를 구분하고, DO 주기적 메모리는 해당 namespace로 한정합니다. 이 통계는 표본을 사용하므로 로컬 동시 전송 검사의 메모리 관측과 함께 판단합니다.

GitHub의 공개 저장소 일반 실행기 시간은 무료 범위입니다. 예약은 default branch에서 실행되며 공개 저장소가 60일 동안 비활성 상태이면 중단될 수 있습니다. 가격·한도와 예약 동작의 공식 근거는 [배포 설계](design/cloudflare-deployment.md)에 기록되어 있습니다.
