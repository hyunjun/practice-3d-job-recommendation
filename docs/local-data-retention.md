# 로컬 자료 보존과 정리 — 2026-09-28

사용자 요청에 따라 `.local/`의 재생성 가능한 자료를 삭제하고, 과거의 같은 상태를 다시 얻을 수 없는 자료는 보존합니다. 삭제 전에 미커밋 소스·조사 결론·최종 검증 수치를 Git에 저장하고, 실제 수집 원본은 중복을 제거한 로컬 압축본으로 보관했습니다.

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

삭제 전 `.local/`의 디스크 사용량은 **34,515,100 KiB**였습니다. 원본 압축과 해시 검증, 소스 보관 브랜치 생성은 완료했습니다. 이 문서와 조사·검증 기록을 먼저 커밋한 뒤 삭제 결과를 추가합니다.

이번 작업은 자료 정리와 기록 보존으로, 제품·공개 테스트를 변경하지 않습니다. 기능 검사를 새로 실행한 결과로 보고하지 않으며, 파일 무결성·Git 보존·삭제 범위·프로세스 종료 상태를 확인합니다.
