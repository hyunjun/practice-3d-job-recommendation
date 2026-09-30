# 로컬 자료 보존과 정리 — 2026-09-28

사용자 요청에 따라 `.local/`의 재생성 가능한 자료를 삭제하고, 과거의 같은 상태를 다시 얻을 수 없는 자료는 보존합니다. 삭제 전에 미커밋 소스·조사 결론·최종 검증 수치를 Git에 저장하고, 실제 수집 원본은 중복을 제거한 로컬 압축본으로 보관했습니다.

앞부분은 2026-09-28 정리 당시의 기록입니다. 최신 상태는 아래의 **2026-09-30 · 73단계 종료 후 정리**를 기준으로 합니다.

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
