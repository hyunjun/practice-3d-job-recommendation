# 로컬 자료 보존과 정리 — 2026-09-28

사용자 요청에 따라 `.local/`의 재생성 가능한 자료를 삭제하고, 과거의 같은 상태를 다시 얻을 수 없는 자료는 보존합니다. 삭제 전에 미커밋 소스·조사 결론·최종 검증 수치를 Git에 저장하고, 실제 수집 원본은 중복을 제거한 로컬 압축본으로 보관했습니다.

앞부분은 2026-09-28 정리 당시의 기록입니다. 최신 상태는 아래의 **2026-10-01 · 76단계 종료 후 정리**를 기준으로 합니다.

## Git에 보존한 자료

제품의 기준 커밋은 `a6a8900bc4b6b2f4a008ece45ed16b367ce66ad9`입니다. 완료된 구현과 단계별 검증은 [개선 기록](improvements.md)에 있습니다.

아래 브랜치는 삭제할 임시 작업 공간의 소스를 그대로 보존하는 **로컬 보관 브랜치**입니다. 현재 제품에 다시 적용하거나 새로 검증한 변경이라는 뜻은 아닙니다. 소스 파일 전부를 커밋의 blob과 바이트 단위로 대조했습니다. 의존성을 가리키던 `node_modules` 심볼릭 링크는 저장하지 않았습니다.

| 브랜치 (`archive/cleanup-2026-09-28/` 아래) | 커밋 | 보존 내용 |
| --- | --- | --- |
| `stage-67-worker` | `d809a342826002a95cd2ad8077e500d64c8148bd` | Worker 도입 당시 미커밋 초안 11파일 |
| `stage-68-presentation` | `2db0aca81bf0dfb7d1d3a5bfec1ddfade9eb8382` | 화면 갱신 초안 12파일 |
| `stage-70-regions` | `f0eff9092504c461ff7c4abc37660f00b65b02dd` | 지역 확장 소스·문서·테스트 초안 49파일 |
| `performance-tools` | `a166bc1b63b51369a0ab85be288c7d6b72aa2a65` | 작성한 성능 계측·자료 준비 스크립트와 안내 35파일 |

Git 문서에는 다음 자료를 추가했습니다.

- [채용 트렌드 조사](hiring-trends-research.md): 국내 참고 사이트와 해외 8개 서비스, 표본·집계 단위·운영 비용에 대한 당시의 판단.
- [LinkedIn 수집 검토](linkedin-source-assessment.md): 실제로 확인한 공개 페이지·정책·API 범위와 수집하지 않은 이유.
- [성능 측정 수치](benchmarks/catalog-2026-09-27.json): 최종 metric-v2 30회 측정의 실행별 수치와 집계·한계. 잘못된 RAF 시각을 사용한 v1 결론은 제외.
- [지역 확장 검증 기록](validation/regional-coverage-2026-09-27.json): 최종 파일별 DEV·PROD 검사 결과와 소스 대조 결과. 최초 실패와 영향 범위 재실행을 구분.

실제 공고 본문·외부 페이지 전체 응답·브라우저 화면·프로세스 토큰은 Git에 추가하지 않았습니다.

## 로컬에 남기는 자료

| 경로 | 내용 |
| --- | --- |
| `.local/observations-v1/public-board-cache-v5.json` | 날짜별 관측 이력 41,945바이트. 기존 경로와 내용 유지 |
| `.local/preserved-2026-09-28/historical-inputs.zip` | 당시의 공고·외부 출처 응답·조회 맥락·참고 사이트 화면을 보존한 압축본 |
| 같은 폴더의 `manifest.json` | 원래 상대 경로 → SHA-256 blob, 크기, 권한, 보존 이유의 대응표. ZIP 안에도 동일한 사본 포함 |
| 같은 폴더의 `verification.json` | 압축본·manifest 해시, 모든 압축 항목의 복원·해시 대조 결과 |
| 같은 폴더의 `measurement-context.json`, `supplements.json` | 당시 성능 검사의 실제 공고 기대값과 원래 경로·해시 |

압축본은 원래 **4,162개 경로·2,608,288,694바이트**를 **3,808개 고유 blob·247,075,859바이트 ZIP**으로 보존합니다. 같은 내용은 한 번만 저장합니다. 예전 단계별 tar.gz 안의 원본 115개도 추출해 원래 manifest의 해시와 대조했습니다.

ZIP의 SHA-256은 `b7114d8f6bce0ea43236ba54601eeccbfab7593493f936ad1842291a475dd85a`입니다. ZIP을 닫은 뒤 모든 blob을 다시 읽어 크기·CRC·SHA-256과 전체 항목 목록을 확인했습니다.

관측 이력의 SHA-256은 `9e2bff5ff6617698dcf032ef4f77d454bc346bff07dd0d03fa5c8977493dbaab`입니다. 같은 원본의 압축 사본도 보존했습니다. 최신 공고 6,819건을 담은 캐시의 SHA-256은 `5cf05a030c7552f24f2e757927e2168914a24702507ff7a1fcbfe608e28fac74`이며 ZIP에서 복원할 수 있습니다.

이 자료는 `.gitignore`에 따라 로컬에만 남습니다. Git으로 복구하는 소스·문서와 별도로 보관하는 과거 수집 자료입니다.

## 재생성 가능한 자료

정리 대상은 임시 worktree, 복사한 소스·의존성·빌드, Vite 캐시, 가상 E2E 자료, Playwright 보고서·trace·화면, CPU 프로파일, 상세 실행 로그, 이전 검증용 압축 묶음, 서버 실행 메타데이터와 운영 캐시의 펼쳐진 사본입니다.

제품 소스·공개 테스트·잠금 파일·로컬 의존성은 프로젝트 루트에 유지합니다. 원본 공고와 과거 관측은 위 압축본과 관측 파일로 보존하며, 기존 `.local/research/` 경로의 QA 산출물을 모두 유지하는 방식은 아닙니다.

캐시 파일을 삭제한 뒤 첫 서버 실행은 공개 공고를 다시 수집합니다. 이 정리 자체는 서버를 시작하거나 외부 수집 요청을 보내지 않습니다. 브라우저 IndexedDB/localStorage에 저장된 메모·지원 상태는 파일 정리 대상에 포함되지 않습니다.

## 필요한 원본만 복원하기

프로젝트 루트에서 아래 예시로 최신 전체 공고 캐시 한 파일을 복원할 수 있습니다. 기존 캐시가 있으면 덮어쓰지 않습니다. 이는 과거 스냅샷의 복원이며 현재 공고가 여전히 게시 중이라는 확인은 아닙니다.

```python
from pathlib import Path
import hashlib
import json
import zipfile

folder = Path(".local/preserved-2026-09-28")
original_path = "public-board-cache-v5.json"
target = Path(".local") / original_path
with zipfile.ZipFile(folder / "historical-inputs.zip") as archive:
    manifest = json.loads(archive.read("manifest.json"))
    entry = next(item for item in manifest["entries"]
                 if item["path"] == original_path)
    content = archive.read("blobs/" + entry["sha256"])
    assert len(content) == entry["bytes"]
    assert hashlib.sha256(content).hexdigest() == entry["sha256"]
    with target.open("xb") as output:
        output.write(content)
```

다른 자료의 원래 경로는 `manifest.json`에서 확인할 수 있습니다. 성능 스크립트는 해당 보관 브랜치의 README에 원래 위치와 재준비 조건을 기록했습니다.

## 정리 상태

정리를 완료했습니다. 조사·검증 기록과 보존 계획은 삭제 전에 `1e27bf434f53beedbc8a040c22a1d7a5ac15bd92`로 커밋했습니다. 위 네 보관 브랜치도 삭제 전에 생성했으며 로컬에 유지합니다.

| 측정 | 정리 전 | 정리 후 |
| --- | ---: | ---: |
| `.local/` 사용량 (`du -sk`) | 34,515,100 KiB / 32.92 GiB | 246,876 KiB / 241.09 MiB |
| 파일시스템 여유 공간 (`df -k`) | 31,652,060 KiB | 45,815,744 KiB |
| 등록된 worktree | 프로젝트 루트 + 임시 3곳 | 프로젝트 루트 1곳 |

`.local/` 사용량은 **99.28% 감소**했습니다. 파일시스템 전체 여유 공간의 측정 증가분은 약 **13.51 GiB**이며, 디렉터리 사용량 감소와 구분합니다.

`.local/`에는 `observations-v1/`과 `preserved-2026-09-28/` 두 폴더만 남았습니다. 이번 정리용 스크립트·임시 목록도 제거했습니다. 원래 `research/`의 파일·하위 디렉터리 93개, 임시 worktree 3곳, 검증 산출물·의존성 사본·캐시·실행 로그를 정리했습니다.

삭제 후에도 다음을 확인했습니다.

- ZIP의 manifest와 별도 manifest가 같고, 최신 캐시 원본의 SHA-256이 일치함. 복원한 JSON은 version 5, 130개 게시판, 6,819개 공고이며 운영 캐시 경로에는 다시 쓰지 않음.
- 관측 이력 41,945바이트의 해시가 정리 전과 같음.
- 네 보관 브랜치가 원래 보존 커밋을 가리키고 `git fsck --connectivity-only --no-dangling`이 통과함.
- 제품·공개 테스트와 루트 의존성을 유지하고, 확인용 8787 서버는 종료 상태임.

이번 작업은 자료 정리와 기록 보존으로 제품·공개 테스트를 변경하지 않았습니다. E2E·단위 검사·빌드를 새로 실행한 결과로 보고하지 않습니다. 보존한 성능 수치와 파일별 검증 수치가 기존 기록과 일치하는지, 문서 링크·민감한 경로·토큰·Git 변경 범위·파일 무결성을 확인했습니다.

## 2026-09-30 · 72단계 종료 후 정리

외부 채용 응답 크기 제한의 구현·테스트·검증 결과를 `be279d50f25585e29e205c464be4470e4feddf8c`로 커밋하고 `origin/main`에 push한 뒤 임시 자료를 삭제했습니다. 설계·구현 검토·최종 검증에서 주 담당, GPT-6 Astra Max, Claude Code Fable 5.1 Max의 명시적인 합의를 받았습니다. [단계 기록](validation/provider-response-bounds-2026-09-30.json)에 승인 대상 해시와 실제 실행 결과가 있습니다.

재사용할 조사·검증 도구와 합의·결과 기록 **91개 파일**을 먼저 로컬 브랜치 `archive/cleanup-2026-09-30/stage-72-verification-tools`의 `8e25ee1291306cebc2eacd2c345e49c67d2b7da8`로 보존하고, Git blob을 원래 바이트와 대조했습니다. 이 브랜치는 push하지 않았습니다. 원래 경로·해시 목록은 해당 커밋의 `.local/research/72-response-bounds/main/archive-manifest.json`에서 복원할 수 있습니다. 공개 Git에는 실제 외부 응답 본문이나 상세 실행 로그를 추가하지 않았습니다.

이전 71단계의 로컬 보관 브랜치 `archive/cleanup-2026-09-30/stage-71-verification-tools`와 커밋 `bb6e239e2d6ec34b55512cf239a9a34d4198a380`도 유지합니다. 이전 보관 자료는 이번 단계의 새 검증 결과로 계산하지 않습니다.

### 삭제와 보존 결과

| 항목 | 정리 결과 |
| --- | --- |
| `.local/` 할당 사용량 (`du -sk`) | 2,968,724 KiB / 2.83 GiB → 242,636 KiB / 236.95 MiB |
| 삭제한 작업 영역 | `.local/e2e-default`, `.local/playwright`, `.local/research`, `dist`, `dist-server`, `public/pdf`, `node_modules/.vite`, `node_modules/.vite-temp` |
| 남은 `.local/` 파일 | 관측·압축 원본·보존 정보 14개 |
| 기존 보관 자료·관측 | 10개 파일의 크기·SHA-256 불변 |
| 검증받은 제품·테스트 소스 | 395개 파일의 SHA-256 불변 |
| 실행 환경 | 프로젝트 worktree 1곳, 확인용 8787·검증용 5173 포트에 리스너 없음 |

`research/59`, `research/60`의 소스·의존성·빌드 사본과 화면·캐시는 이번에 실행한 게시 상태·관측 E2E가 만든 자료였습니다. `research/64-expansion`에는 가상 검사용 빈 디렉터리만 있었습니다. 재생성에 필요한 fixture 소스는 제품 저장소에 남기고, 이 사본들과 72단계의 브라우저·보고서·로그·화면·실행 도구 사본을 제거했습니다. 실행 결과 요약·해시·합의 기록은 Git에서 확인할 수 있지만 원시 보고서와 화면 파일은 삭제됐습니다.

`.local/`에는 다음 네 폴더만 남았습니다.

- `observations-v1/`: 날짜별 관측 이력 1개.
- `preserved-2026-09-28/`: 과거 원본 ZIP과 보존 정보 5개.
- `preserved-2026-09-30/`: 71단계 원본 ZIP과 보존 정보 4개.
- `preserved-2026-09-30-stage-72/`: 이번에 조회한 공식 레퍼런스의 원본 ZIP과 보존 정보 4개.

새 `stage-72-reference-inputs.zip`은 당시 공식 문서 응답 3개와 조회 기록 1개를 보존합니다. 원본 총 929,169바이트를 136,633바이트 ZIP으로 압축했고, SHA-256은 `9c4e4dd9bd18ec446df00c7d3735e892528bb72e498e6ccf4eb15888fbe93dc1`입니다. 전체 항목·CRC·크기·해시와 원래 바이트가 일치함을 삭제 전에 확인했습니다. ZIP·manifest 해시는 삭제 후에도 같으며, 이 새 폴더의 `verification.json`에는 작업 사본 삭제 완료 시각을 기록했습니다.

검증 실행의 소유 서버·브라우저가 종료됐고, Astra agent를 닫았으며 Fable CLI 호출도 모두 종료됐습니다. 프로젝트 루트 의존성과 사용자 앱의 전역 기록은 유지합니다. 이번 정리 과정은 제품이나 테스트를 변경하지 않았으므로 새 E2E·단위 검사·빌드를 실행한 것으로 보고하지 않습니다.

정확한 시각·삭제 경로·남은 파일·해시는 [정리 결과](validation/provider-response-bounds-cleanup-2026-09-30.json)에 있습니다. [최종 검증 근거](validation/provider-response-bounds-final-evidence-2026-09-30.json)는 전원 승인 당시의 상태로 보존하며, 그 안의 원시 자료 존재·삭제 대기 문구는 정리 이전 시점의 기록입니다.

## 2026-09-30 · 73단계 종료 후 정리

Worker 실패 후 공고 만료와 검색 조건을 정확히 표시하는 개선을 `1dcf936fa0b320f03d3b8081108867550c71a8a4`로 커밋하고 `origin/main`에 push한 뒤 정리했습니다. 주 담당, GPT-6 Astra Max, Claude Code Fable 5.1 Max가 같은 최종 소스와 검증 근거를 명시적으로 승인했습니다. 최종 타입 검사·단위 2,704개/82파일·빌드와 관련 9파일의 개발 81개·배포 81개 E2E가 통과했습니다. 최초 검사 오류와 잠자기로 중단된 배포 검사도 [단계 기록](validation/catalog-resilience-2026-09-30.json)에 구분해 남겼습니다.

재사용할 도구·설계 논의·합의·실행 결과 **167개 파일**을 로컬 브랜치 `archive/cleanup-2026-09-30/stage-73-verification-tools`의 `0843f8e239d26321fe1e61aa845b14b0d8a4c19e`로 먼저 보존했습니다. 모든 Git blob이 원래 바이트와 같음을 확인했으며 이 브랜치는 push하지 않았습니다. 해당 커밋의 `.local/research/73/main/archive-manifest.json`에 원래 경로와 해시가 있습니다. 상세 로그·모델 스트림·화면·trace는 검토를 마친 뒤 삭제했고, 결과·실패 근거·해시는 Git에 남겼습니다.

| 항목 | 정리 결과 |
| --- | --- |
| `.local/` 할당 사용량 (`du -sk`) | 926,684 KiB / 904.96 MiB → 242,816 KiB / 237.12 MiB |
| 삭제한 작업 영역 | `.local/e2e-default`, `.local/research`, `dist`, `dist-server`, `public/pdf`, `node_modules/.vite`, `node_modules/.vite-temp` |
| 남은 `.local/` 파일 | 관측·압축 원본·보존 정보 18개 |
| 기존 보관 자료·관측 | 14개 파일의 크기·SHA-256 불변 |
| 검증받은 제품·테스트 소스 | 402개 파일의 SHA-256 불변 |
| 실행 환경 | 프로젝트 worktree 1곳, 확인용 8787·검증용 5173 포트에 리스너 없음 |

남은 폴더는 기존 `observations-v1/`, `preserved-2026-09-28/`, `preserved-2026-09-30/`, `preserved-2026-09-30-stage-72/`와 새 `preserved-2026-09-30-stage-73/`입니다. 새 폴더는 당시 공식 레퍼런스 응답 6개와 조회 기록 2개를 압축한 `stage-73-reference-inputs.zip`, manifest, 검증 기록, README로 구성됩니다. 원본 1,058,456바이트를 168,080바이트 ZIP으로 보존했으며 ZIP의 SHA-256은 `e7ecd8140dca896d6e8a82963def4c1e481c2e0b5d2c4c4b6f662556ca336850`입니다. 전체 항목·CRC·크기·해시와 작업 사본의 바이트가 같음을 삭제 전에 확인했고, 삭제 후에도 ZIP·manifest 해시와 기존 14개 파일을 다시 대조했습니다.

16개 Fable CLI 호출과 검증 실행의 소유 서버·브라우저가 모두 종료됐고 Astra agent도 닫았습니다. 검증 중 사용한 작업 전용 잠자기 방지 프로세스는 소유자를 확인해 명시적으로 종료했으며 영구 전원 설정은 변경하지 않았습니다. 루트 의존성과 사용자 앱의 전역 기록은 유지합니다. 제품이나 테스트를 수정하지 않은 정리 과정에 E2E를 다시 실행하지 않았습니다.

[정리 결과](validation/catalog-resilience-cleanup-2026-09-30.json)에 실제 삭제 경로·시각·남은 파일·해시·프로세스 종료를 기록했습니다. [최종 검증 근거](validation/catalog-resilience-final-evidence-2026-09-30.json)는 전원 승인 당시의 바이트 그대로 유지하며, 그 안의 원시 자료 위치는 정리 이전 시점의 기록입니다. 디렉터리 할당 사용량 감소는 파일시스템 전체 여유 공간의 증가를 측정한 값이 아닙니다.

## 2026-09-30 · 74단계 종료 후 정리

회사별 실패·정상 본문 확인·재시도 시각의 근거를 바로잡는 개선을 `62a5e75720d8e3760bcf2420df6991f1be412fd4`로 커밋하고 `origin/main`에 push한 뒤 정리했습니다. 설계·구현 검토·최종 검증에서 주 담당, GPT-6 Astra Max, Claude Code Fable 5.1 Max가 같은 해시에 명시적으로 동의했습니다. 최종 타입 검사·단위 2,736개/84파일·빌드와 관련 11파일의 개발 93개·배포 93개 E2E가 통과했습니다. 두 차례 실패와 테스트 수정, 검증의 범위와 한계는 [단계 기록](validation/board-status-provenance-2026-09-30.json)에 구분해 남겼습니다.

재사용할 도구·설계 논의·합의·실행 결과 **170개 파일**을 로컬 브랜치 `archive/cleanup-2026-09-30/stage-74-verification-tools`의 `3a863be4670bfa24df858bf30aab05c3f48fe20f`로 먼저 보존했습니다. 모든 Git blob이 원래 바이트와 같음을 확인했으며 이 브랜치는 push하지 않았습니다. 해당 커밋의 `.local/research/74/main/archive-manifest.json`에 원래 경로·크기·해시가 있고, `.local/research/74/ARCHIVE-README.md`에 복원 범위와 새 실행의 준비 조건이 있습니다. 상세 로그·모델 스트림·화면·trace는 검토를 마친 뒤 삭제했습니다.

| 항목 | 정리 결과 |
| --- | --- |
| `.local/` 할당 사용량 (`du -sk`) | 3,137,308 KiB / 2.99 GiB → 242,992 KiB / 237.30 MiB |
| 삭제한 작업 영역 | `.local/e2e-default`, `.local/research`, `dist`, `dist-server`, `public/pdf`, `node_modules/.vite`, `node_modules/.vite-temp` |
| 남은 `.local/` 파일 | 관측·압축 원본·보존 정보 22개 |
| 기존 보관 자료·관측 | 18개 파일의 크기·SHA-256 불변 |
| 검증받은 제품·테스트 소스 | 408개 파일의 SHA-256 불변 |
| 실행 환경 | 프로젝트 worktree 1곳, 확인용 8787·검증용 5173 포트에 리스너 없음 |

남은 폴더는 기존 `observations-v1/`, `preserved-2026-09-28/`, `preserved-2026-09-30/`, `preserved-2026-09-30-stage-72/`, `preserved-2026-09-30-stage-73/`와 새 `preserved-2026-09-30-stage-74/`입니다. 새 폴더에는 당시 RFC 9110·9111 응답과 조회 기록 총 4개를 압축한 `stage-74-reference-inputs.zip`, manifest, 검증 기록, README를 남겼습니다. 원본 588,387바이트를 164,853바이트 ZIP으로 보존했으며 SHA-256은 `b37a5602163eafabe3f05cc5d915de075086d4e53abf99dbd8c931914a7596ec`입니다. ZIP 항목·CRC·크기·해시와 작업 원본을 삭제 전에 대조했고, 삭제 후에도 ZIP·manifest와 기존 18개 파일의 해시가 같음을 확인했습니다.

16개 Fable CLI 호출과 검증 실행의 소유 서버·브라우저가 모두 종료됐고 Astra agent도 닫았습니다. 검증 중 갱신해 사용한 작업 전용 잠자기 방지의 세 실행은 소유 wrapper와 자식 프로세스를 확인해 모두 종료했습니다. 영구 전원 설정은 바꾸지 않았습니다. 루트 의존성과 사용자 앱의 전역 기록은 유지합니다.

[정리 결과](validation/board-status-provenance-cleanup-2026-09-30.json)에 실제 삭제 경로·시각·남은 파일·해시·프로세스 종료를 기록했습니다. [최종 검증 근거](validation/board-status-provenance-final-evidence-2026-09-30.json)는 승인 당시의 바이트 그대로 유지하며, 그 안의 원시 자료 위치는 정리 이전 시점의 기록입니다. 제품·테스트를 수정하지 않은 정리 과정에서 E2E를 다시 실행하지 않았습니다. 디렉터리 할당 사용량 감소는 파일시스템 전체 여유 공간의 증가를 측정한 값이 아닙니다.

## 2026-09-30 · 75단계 종료 후 정리

앞선 게시 상태 확인을 기다리는 동안에도 현재 공고와 대기 안내를 먼저 표시하는 개선을 `052d85f193182dafdaaea481eaf969846c6d1843`로 커밋하고 `origin/main`에 push한 뒤 정리했습니다. 설계, 최종 소스·테스트·실행 계획, 최종 검증 근거에 대해 주 담당·GPT-6 Astra Max·Claude Code Fable 5.1 Max가 명시적으로 동의했습니다. 타입 검사·단위 2,824개/87파일·빌드와 같은 17파일의 개발 157개·배포 157개 E2E가 통과했습니다. 초기 테스트 타입 오류와 수정·재실행을 [단계 기록](validation/catalog-queued-progress-2026-09-30.json)에 구분했습니다.

재사용할 도구·설계 논의·합의·실행 결과 **167개 파일**을 로컬 브랜치 `archive/cleanup-2026-09-30/stage-75-verification-tools`의 `c01c91e06abbe913e06897c29f24357f1cc85a59`로 먼저 보존했습니다. 모든 Git blob을 원래 바이트와 대조했으며 이 브랜치는 push하지 않았습니다. 해당 커밋의 `.local/research/75/main/archive-manifest.json`에 원래 경로·크기·해시가 있고 `.local/research/75/ARCHIVE-README.md`에 복원 범위가 있습니다. 실제 외부 응답 본문과 상세 원시 로그·모델 스트림·화면·trace는 이 보관 커밋에 넣지 않았습니다.

| 항목 | 정리 결과 |
| --- | --- |
| `.local/` 할당 사용량 (`du -sk`) | 2,294,008 KiB / 2.19 GiB → 243,036 KiB / 237.34 MiB |
| 삭제한 작업 영역 | `.local/e2e-default`, `.local/research`, `dist`, `dist-server`, `public/pdf`, `node_modules/.vite`, `node_modules/.vite-temp` |
| 남은 `.local/` 파일 | 관측·압축 원본·보존 정보 26개 |
| 기존 보관 자료·관측 | 22개 파일의 크기·SHA-256 불변 |
| 검증받은 제품·테스트 소스 | 414개 파일의 SHA-256 불변 |
| 실행 환경 | worktree 1곳, 확인용 8787·검증용 5173 포트에 리스너 없음 |

이전 보관 폴더와 `observations-v1/`을 유지하고, 새 `.local/preserved-2026-09-30-stage-75/`에는 당시 RFC 7240·WCAG 상태 안내 원문과 조회 기록을 압축한 `stage-75-reference-inputs.zip`, manifest, 검증 기록, README를 남겼습니다. 원본 3개·94,176바이트를 30,805바이트 ZIP으로 보존했고 SHA-256은 `9e0e53f5b3e2e6596e482827cc24c8e59b573e6ebc4033aae807ea5fbea96a62`입니다. ZIP 항목·CRC·크기·해시를 작업 원본과 대조했으며, 정리 후 ZIP·manifest와 기존 22개 파일의 해시가 유지됐습니다.

Fable CLI 호출 15개와 검증용 서버·브라우저가 모두 종료됐고 Astra agent도 닫았습니다. 작업 전용 잠자기 방지의 두 실행은 소유 wrapper와 자식의 프로세스 식별 정보를 확인해 종료했습니다. 영구 전원 설정은 바꾸지 않았습니다. 루트 의존성과 사용자 앱의 전역 기록은 정리 범위에 포함하지 않습니다.

[정리 결과](validation/catalog-queued-progress-cleanup-2026-09-30.json)에 실제 삭제 시각·경로·남은 파일·해시·프로세스 종료를 기록했습니다. [최종 검증 근거](validation/catalog-queued-progress-final-evidence-2026-09-30.json)는 승인 당시의 바이트 그대로이며, 그 안의 원시 자료 경로와 삭제 대기 상태는 정리 전 시점의 기록입니다. 제품·테스트를 바꾸지 않은 정리 과정에서 E2E를 다시 실행하지 않았습니다. 디렉터리 할당 사용량 감소는 파일시스템 전체 여유 공간 증가를 측정한 값은 아닙니다.

## 2026-10-01 · 76단계 종료 후 정리

급여 숫자 전체와 범위 경계를 읽고 모호한 금액은 원문 근거로 남기는 개선을 `8ad2d119e48910cb03358c9d7b5bef454fbb5686`로 커밋하고 `origin/main`에 push한 뒤 정리했습니다. 설계·구현·최종 검증에서 주 담당·GPT-6 Astra Max·Claude Code Fable 5.1 Max가 같은 해시에 명시적으로 동의했습니다. 최종 타입 검사·단위 2,978개/89파일·빌드와 같은 20파일의 개발 194개·배포 194개 E2E가 통과했습니다. 처음 개발 E2E의 193개 통과·1개 실패와 테스트 수정, 재실행 결과는 [단계 기록](validation/compensation-number-format-2026-10-01.json)에 구분해 보존합니다.

재사용할 도구·설계 논의·합의·실패와 실행 결과 **283개 파일**을 로컬 브랜치 `archive/cleanup-2026-10-01/stage-76-verification-tools`의 `1179a885b5d558036384044163656440527d8c4f`로 먼저 보존했습니다. 모든 Git blob이 원래 바이트와 같음을 확인했으며 이 브랜치는 로컬에만 있습니다. 해당 커밋의 `.local/research/76/main/archive-manifest.json`에 경로·크기·해시가 있고 `.local/research/76/ARCHIVE-README.md`에 복원 범위가 있습니다. 일부 진단 기록에는 과거 공고의 발췌문이 있으므로 로컬 보관용입니다. 전체 외부 응답은 별도 원본 압축본으로 보존하고 상세 로그·모델 스트림·화면·trace는 검토 후 삭제했습니다.

| 항목 | 정리 결과 |
| --- | --- |
| `.local/` 할당 사용량 (`du -sk`) | 2,067,484 KiB / 1.97 GiB → 243,112 KiB / 237.41 MiB |
| 삭제한 작업 영역 | `.local/e2e-default`, `.local/research`, `dist`, `dist-server`, `public/pdf`, `node_modules/.vite`, `node_modules/.vite-temp` |
| 남은 `.local/` 파일 | 관측·압축 원본·보존 정보 30개, 파일 내용 합계 248,855,448바이트 |
| 기존 보관 자료·관측 | 26개 파일의 크기·SHA-256 불변 |
| 검증받은 제품·테스트 소스 | 419개 파일의 SHA-256 불변 |
| 실행 환경 | worktree 1곳, 확인용 8787·검증용 5173 포트에 리스너 없음 |

삭제 직전에 생성 자료 9,734개 파일과 심볼릭 링크 8,937개를 목록·크기·해시 또는 링크 대상으로 재대조했습니다. 기존 단위 검사가 만든 가상 캐시 26개 파일도 생성 코드와 실제 내용을 검토하고 해시가 같은지 다시 확인했습니다. 디렉터리 내부 링크를 따라 원래 의존성을 삭제하지 않았습니다. 참고 문서의 텍스트 추출본 2개는 보존된 HTML의 텍스트 노드와 공백 정규화로 내용을 그대로 재구성할 수 있음을 확인한 뒤 삭제했습니다.

기존 원본·관측 폴더를 유지하고 새 `.local/preserved-2026-10-01-stage-76/`에는 Greenhouse·Unicode 공식 문서 원문과 조회 기록을 압축한 `stage-76-reference-inputs.zip`, manifest, 검증 기록, README를 남겼습니다. 원본 3개·320,638바이트를 62,612바이트 ZIP으로 보존했고 SHA-256은 `d2daa74863e98ba45c2e054c777bcab84ab0c919acad84877ec97d9fca55a2c4`입니다. 전체 항목·CRC·크기·해시와 작업 사본의 일치를 삭제 전에 확인했으며, 삭제 후 ZIP·manifest와 기존 26개 파일의 해시가 유지됐습니다.

Fable CLI 호출 15개와 검증 실행 7개의 소유 프로세스가 모두 종료됐고 Astra agent도 닫았습니다. 작업 전용 잠자기 방지 프로세스는 소유자 확인 후 종료했으며 영구 전원 설정은 바꾸지 않았습니다. 루트 의존성과 사용자 앱의 전역 기록은 정리 범위 밖입니다.

[정리 결과](validation/compensation-number-format-cleanup-2026-10-01.json)에 실제 삭제 시각·경로·남은 파일·해시와 프로세스 종료를 기록했습니다. [승인한 최종 근거](validation/compensation-number-format-final-evidence-2026-10-01.json)는 승인 당시의 바이트 그대로이며, 그 안의 원시 자료 경로와 삭제 대기 상태는 정리 전 시점의 기록입니다. 제품·테스트를 바꾸지 않은 정리와 문서 갱신에 E2E를 다시 실행하지 않았습니다. 디렉터리 할당 사용량 감소는 파일시스템 전체 여유 공간 증가를 측정한 값은 아닙니다.

## 2026-10-01 · 77단계 종료 후 정리

급여의 구성·기간과 해당 금액의 원문 근거를 바로잡는 개선을 `976963d206b64491f0570c0a52a8b3f28c04a065`로 커밋하고 `origin/main`에 push한 뒤 정리했습니다. 설계·구현·최종 검증에서 주 담당·GPT-6 Astra Max·Claude Code Fable 5.1 Max가 같은 해시에 명시적으로 동의했습니다. 최종 타입 검사·단위 3,286개/92파일·빌드와 같은 22파일의 개발 201개·배포 201개 E2E가 통과했습니다. 최초 단위 검사 2개 실패와 수정, 직급 원문 누락의 발견·회귀 보강, 실행 보고서의 정정 합의도 [단계 기록](validation/compensation-context-2026-10-01.json)에 구분해 보존했습니다.

재사용할 도구·설계 논의·합의·실패와 실행 결과 **442개 파일**을 로컬 브랜치 `archive/cleanup-2026-10-01/stage-77-verification-tools`의 `8beab719f03b34de97f310db23b09c7303df0aca`로 먼저 보존했습니다. 모든 Git blob이 원래 바이트와 같음을 확인했고 원격에 이 브랜치가 없음을 대조했습니다. 해당 커밋의 `.local/research/77/main/archive-manifest.json`에 경로·크기·해시가 있으며 `.local/research/77/ARCHIVE-README.md`에 복원 범위가 있습니다. 일부 진단 기록에는 과거 공고의 발췌문이 있으므로 로컬 보관용입니다. 상세 로그·모델 스트림·화면·trace는 검토 결과와 해시를 남긴 뒤 삭제했습니다.

| 항목 | 정리 결과 |
| --- | --- |
| `.local/` 할당 사용량 (`du -sk`) | 1,648,868 KiB / 1.57 GiB → 243,192 KiB / 237.49 MiB |
| 삭제한 작업 영역 | `.local/e2e-default`, `.local/research`, `dist`, `dist-server`, `public/pdf`, `node_modules/.vite`, `node_modules/.vite-temp` |
| 남은 `.local/` 파일 | 관측·압축 원본·보존 정보 34개, 파일 내용 합계 248,924,049바이트 |
| 기존 보관 자료·관측 | 30개 파일의 크기·SHA-256 불변 |
| 검증받은 제품·테스트 소스 | 425개 파일의 SHA-256 불변 |
| 실행 환경 | worktree 1곳, 확인용 8787·검증용 5173 포트에 리스너 없음 |

삭제 직전에 생성 자료 5,418개 파일과 심볼릭 링크 4,485개를 목록·크기·해시 또는 링크 대상으로 재대조했습니다. 기존 단위 검사가 만든 가상 캐시 26개 파일은 생성 코드와 실제 바이트를 주 담당과 Astra가 독립적으로 확인했으며, 삭제 직전에도 동일한 파일 집합·해시를 확인했습니다. 디렉터리 내부 링크를 따라 원래 의존성을 삭제하지 않았습니다.

기존 원본·관측 폴더를 유지하고 새 `.local/preserved-2026-10-01-stage-77/`에는 Google JobPosting·schema.org baseSalary·ACAS 보너스 문서의 당시 원문과 조회 기록을 압축한 `stage-77-reference-inputs.zip`, manifest, 검증 기록, README를 남겼습니다. 원본 4개·364,385바이트를 66,304바이트 ZIP으로 보존했으며 SHA-256은 `f16362e22fa65291592012fe28c4a2981ac0341b18ad6ee6e5c07a7b427ba915`입니다. 웹 문서의 내용은 이후 달라질 수 있어 당시 판단의 근거로 보존합니다. 전체 항목·CRC·크기·해시와 작업 사본의 일치를 삭제 전에 확인했고, 삭제 후 ZIP·manifest와 기존 30개 파일의 해시가 유지됐습니다.

Fable CLI 호출 21개와 검증 실행 5개의 소유 프로세스가 모두 종료됐고 Astra agent도 닫았습니다. 작업 전용 잠자기 방지의 세 실행은 소유 wrapper·자식 프로세스의 종료를 확인했으며 영구 전원 설정은 바꾸지 않았습니다. 루트 의존성과 사용자 앱의 전역 기록은 정리 범위 밖입니다.

[정리 결과](validation/compensation-context-cleanup-2026-10-01.json)에 실제 삭제 시각·경로·남은 파일·해시와 프로세스 종료를 기록했습니다. [승인한 최종 근거](validation/compensation-context-final-evidence-2026-10-01.json)는 승인 당시의 바이트 그대로이며, 그 안의 원시 자료 경로와 삭제 대기 상태는 정리 전 시점의 기록입니다. 제품·테스트를 바꾸지 않은 정리와 문서 갱신에 E2E를 다시 실행하지 않았습니다. 디렉터리 할당 사용량 감소는 파일시스템 전체 여유 공간 증가를 측정한 값은 아닙니다.

## 2026-10-01 · 78단계 종료 후 정리

저장 화면 복귀·재비교·현재 상세 일치 개선을 `54b52f7b39e5d4c61cf9241a92fbeb8af5d2bc45`로 커밋하고 `origin/main`에 push한 뒤 정리했습니다. 주 담당·GPT-6 Astra Max·Claude Code Fable 5.1 Max가 같은 설계, 소스·테스트·실행 계획과 최종 검증 근거에 명시적으로 동의했습니다. 최종 타입 검사·단위 3,308개/93파일·빌드와 같은 23파일의 개발 251개·배포 251개 E2E가 통과했습니다. 첫 화면 검토의 승인 보류와 보완·재실행, 측정 범위에 대한 표현 정정은 [단계 기록](validation/saved-lifecycle-2026-10-01.json)에 보존했습니다.

재사용할 도구·논의·판단·실행 기록 **432개 파일**을 로컬 브랜치 `archive/cleanup-2026-10-01/stage-78-verification-tools`의 `968c780f3880fb592cbd6268e44cf9cdeb1cfefa`로 먼저 보존했습니다. 모든 Git blob이 원래 바이트와 같음을 확인했고 보관 브랜치는 push하지 않았습니다. 해당 커밋의 `.local/research/78/main/archive-manifest.json`에 경로·크기·해시가, `.local/research/78/ARCHIVE-README.md`에 복원 범위가 있습니다. 모델 결과의 본문은 원래 검토 파일과 일치함을 확인했고 나머지 결과 정보도 별도로 보존했습니다. 상세 모델 스트림·빈 오류 로그·중복 결과 파일·화면·trace·원시 보고서는 필요한 결과와 해시를 남긴 뒤 삭제했습니다.

| 항목 | 정리 결과 |
| --- | --- |
| `.local/` 할당 사용량 (`du -sk`) | 3,365,248 KiB / 3.21 GiB → 243,292 KiB / 237.59 MiB |
| 삭제한 작업 영역 | `.local/e2e-default`, `.local/research`, `dist`, `dist-server`, `public/pdf`, `node_modules/.vite`, `node_modules/.vite-temp` |
| 남은 `.local/` 파일 | 관측·압축 원본·보존 정보 38개, 파일 내용 합계 249,016,097바이트 |
| 기존 보관 자료·관측 | 34개 파일의 크기·SHA-256 불변 |
| 검증받은 제품·테스트 소스 | 429개 파일의 SHA-256 불변 |
| 실행 환경 | worktree 1곳, 확인용 8787·검증용 5173 포트에 리스너 없음 |

삭제 직전에 생성 자료 41,794개 파일과 심볼릭 링크 9,605개를 목록·크기·해시 또는 링크 대상으로 다시 대조했습니다. 단위 검사가 만든 가상 캐시 26개 파일도 생성 코드·실제 바이트의 독립 검토 기록과 대조했습니다. 전체 삭제 대상 목록에는 파일 42,286개가 있으며, 별도로 추가되는 목록 자신과 보관 메타데이터 두 파일까지 검사했습니다. 명시적으로 임시 자료로 분류하지 않은 395개 파일은 모두 Git 보존을 요구했습니다. 기존 공고 상태 E2E의 실행 사본 경로와 단위 캐시 검사 범위를 바로잡은 두 파일 보완안에도 세 담당자가 동의했으며, 원래 도구와 수정 전후 해시를 남겼습니다. 디렉터리 내부 링크를 따라 원래 의존성을 삭제하지 않았습니다.

기존 원본·관측 폴더를 유지하고 새 `.local/preserved-2026-10-01-stage-78/`에는 HTML Standard·MDN 문서의 당시 원문 네 개와 조회 기록을 압축한 `stage-78-reference-inputs.zip`, manifest, 검증 기록, README를 남겼습니다. 원본 5개·672,642바이트를 89,958바이트 ZIP으로 보존했으며 SHA-256은 `b995a04841c5caba8961f352a7f9b0e4d4509b7ad02454fa68e1784952ab9a9a`입니다. 당시 응답은 이후 바뀔 수 있어 판단 근거로 보존합니다. 전체 항목·CRC·크기·해시와 작업 사본의 일치를 삭제 전에 확인했고, 삭제 후 ZIP·manifest와 기존 34개 파일의 해시가 유지됐습니다.

Fable CLI 호출 23개와 검증 실행 8개의 소유 프로세스가 모두 종료됐고 Astra agent도 닫았습니다. 작업 전용 잠자기 방지의 다섯 실행은 소유 wrapper·자식 프로세스의 종료를 확인했으며 영구 전원 설정은 바꾸지 않았습니다. 루트 의존성과 사용자 앱의 전역 기록은 정리 범위 밖입니다.

[정리 결과](validation/saved-lifecycle-cleanup-2026-10-01.json)에 실제 삭제 시각·경로·남은 파일·해시와 프로세스 종료를 기록했습니다. [승인한 최종 근거](validation/saved-lifecycle-final-evidence-2026-10-01.json)는 승인 당시의 바이트 그대로이며, 그 안의 원시 자료 경로와 정리 대기 상태는 삭제 전 시점의 기록입니다. 제품·테스트를 바꾸지 않은 정리와 문서 갱신에 E2E를 다시 실행하지 않았습니다. 디렉터리 할당 사용량 감소는 파일시스템 전체 여유 공간 증가를 측정한 값은 아닙니다.

## 2026-10-02 · 79단계 종료 후 정리

공고의 오래됨 상태만 바뀔 때 Worker가 본문을 반복 전달하지 않도록 개선했습니다. 주 담당·GPT-6 Astra Max·Claude Code Fable 5.1 Max가 같은 설계·소스·실행 계획·최종 근거를 명시적으로 승인했습니다. 타입 검사·단위 3,380개/98파일·빌드와 개발 179개/23파일·배포 573개/79파일 E2E가 통과했습니다. 구현·테스트·검증 기록은 `455976f12adeded543ef27f07a19d6d43c2098cc`로 커밋하고 `origin/main`에 푸시했습니다. 이전 실패·중단 실행과 보고서 정정은 [검증 문서](validation/catalog-worker-aging-2026-10-01.md)에 구분해 남겼습니다.

조사·도구·논의·판단·실행 기록 **2,799개 파일**을 로컬 브랜치 `archive/cleanup-2026-10-01/stage-79-verification-tools`의 `af015fe0914a806b27f736541a8e54dc2742ee59`로 먼저 보존했습니다. 모든 Git blob을 원래 바이트와 대조했고 보관 브랜치를 푸시하지 않았으며 원격에도 없음을 확인했습니다. 해당 커밋의 `.local/research/79/main/archive-manifest.json`에 경로·크기·해시가, `.local/research/79/ARCHIVE-README.md`에 보존 범위가 있습니다. 전체 삭제 목록에서 별도 임시 분류가 없는 자료는 모두 보존 대상으로 처리했습니다. 상세 모델 스트림·결과와 선택한 원시 로그·보고서·화면을 포함하므로 이 브랜치는 로컬 보관용입니다.

| 항목 | 정리 결과 |
| --- | --- |
| `.local/` 할당 사용량 (`du -sk`) | 8,054,764 KiB / 7.68 GiB → 243,384 KiB / 237.68 MiB |
| 삭제한 작업 영역 | `.local/e2e-default`, `.local/research`, `dist`, `dist-server`, `public/pdf`, `node_modules/.vite`, `node_modules/.vite-temp` |
| 남은 `.local/` 파일 | 관측·압축 원본·보존 정보 42개, 파일 내용 합계 249,097,100바이트 |
| 기존 보관 자료·관측 | 38개 파일의 크기·SHA-256 불변 |
| 검증받은 제품·테스트 소스 | 439개 파일의 SHA-256 불변 |
| 실행 환경 | worktree 1곳, 8787·5173 포트에 리스너 없음 |

삭제 직전에 생성 자료 123,355개 파일·심볼릭 링크 7,250개와 별도 단위 검사 가상 캐시 39개 파일을 다시 대조했습니다. 전체 삭제 목록의 파일은 125,057개이며, 그중 별도 임시 분류가 없는 1,663개는 Git 보존을 요구했습니다. 전체 목록 자신과 이후 생성한 보관 manifest·검증 기록도 별도로 검사했습니다. 선택한 검증 원본 490개·193,386,311바이트는 별도 보존 사본과 원래 파일의 일치를 확인한 뒤 로컬 Git에 포함했습니다. 삭제할 디렉터리 안의 링크를 따라 기존 의존성을 삭제하지 않았습니다.

기존 원본·관측 폴더를 유지하고 새 `.local/preserved-2026-10-01-stage-79/`에는 당시 참고한 문서 원문과 조회 기록의 `stage-79-reference-inputs.zip`, manifest, 검증 기록, README를 남겼습니다. 원본 5개·558,881바이트를 78,837바이트 ZIP으로 보존했으며 SHA-256은 `bb4af737c04936a0aba6bfad034f8261669d00c563b29a3089eb757eba0dc9cd`입니다. 웹 응답은 이후 달라질 수 있어 당시 판단 근거로 보존합니다. 항목·CRC·크기·해시와 작업 사본의 일치를 삭제 전에 확인했고, 삭제 후 ZIP·manifest와 기존 38개 파일의 해시가 유지됐습니다.

Fable 호출 54개와 검증 시도 16개의 원래 종료·소유권 기록을 대조했습니다. 실패·중단 이력은 통과로 바꾸지 않았습니다. Astra agent를 닫았고 작업용 잠자기 방지 기록 19개 모두 종료·잔여 프로세스 0개 상태를 확인했습니다. 마지막 전원 유지 wrapper는 실제 종료 코드 0, 소유 자식은 종료 신호에 따른 -15로 관측했습니다. 영구 전원 설정을 바꾸지 않았으며 루트 의존성과 사용자 앱의 전역 기록은 정리 범위 밖입니다.

[정리 결과](validation/catalog-worker-aging-cleanup-2026-10-01.json)에 실제 삭제 시각·경로·남은 파일·해시·소유권 기록이 있습니다. [최종 근거](validation/catalog-worker-aging-final-evidence-2026-10-01.json), [합의 기록](validation/catalog-worker-aging-2026-10-01.json), [후속 보고서 정정](validation/catalog-worker-aging-review-delivery-2026-10-02.json)은 정리 전 시점의 바이트 그대로입니다. 그 안의 임시 경로와 정리 대기 상태는 당시 기록이며, 현재 존재한다고 보고하지 않습니다. 제품·테스트를 바꾸지 않은 정리와 문서 갱신에 E2E를 다시 실행하지 않았습니다. 디렉터리 할당량 감소는 파일시스템 전체 여유 공간 증가의 측정값은 아닙니다.
