# 자산과 데이터 출처

아래 라이선스와 고지는 각각의 외부 자산과 의존성에 적용됩니다. ORBIT 자체 코드의 오픈소스 라이선스는 아직 지정하지 않았습니다.

## 지도

- 지구 위성·야간 텍스처: [three-globe 예제 이미지](https://github.com/vasturiano/three-globe/tree/017a3a5d182b2413f403154d3eb3ed4af3e598ca/example/img). 아래에 원본 파일과 라이선스 고지를 명시했습니다.
- 국가 경계: [world-atlas 2](https://github.com/topojson/world-atlas)의 `countries-110m.json`. 원천 데이터는 [Natural Earth](https://www.naturalearthdata.com/), public domain입니다.
- 3D 엔진: [Three.js](https://threejs.org/), MIT.
- 2D 투영: [D3 Geo](https://github.com/d3/d3-geo), ISC. 위상 데이터 변환: [topojson-client](https://github.com/topojson/topojson-client), ISC.

### 지구 텍스처의 원본과 고지

다음 두 이미지는 파일명만 바꾸어 포함했습니다. 원본 저장소의 [MIT 라이선스 원문](https://github.com/vasturiano/three-globe/blob/017a3a5d182b2413f403154d3eb3ed4af3e598ca/LICENSE)을 [로컬 고지 파일](licenses/three-globe-MIT.txt)에 그대로 보존했습니다. 저작권 표기는 `Copyright (c) 2019 Vasco Asturiano`입니다.

| 로컬 파일 | 원본 파일 |
| --- | --- |
| `public/earth/day.jpg` | [earth-blue-marble.jpg](https://github.com/vasturiano/three-globe/blob/017a3a5d182b2413f403154d3eb3ed4af3e598ca/example/img/earth-blue-marble.jpg) |
| `public/earth/night.jpg` | [earth-night.jpg](https://github.com/vasturiano/three-globe/blob/017a3a5d182b2413f403154d3eb3ed4af3e598ca/example/img/earth-night.jpg) |

출처를 고정한 리비전은 [`017a3a5d182b2413f403154d3eb3ed4af3e598ca`](https://github.com/vasturiano/three-globe/commit/017a3a5d182b2413f403154d3eb3ed4af3e598ca)입니다. 두 이미지가 이 리비전의 원본과 바이트 단위로 동일함을 확인했습니다.

## 도시 사진

[Unsplash License](https://unsplash.com/license)에 따라 받은 사진을 리사이즈해 로컬에 포함했습니다. 사진은 도시의 분위기를 보여주는 장식 이미지이며 회사 사무실 사진이 아닙니다.

| 파일 | 원본 |
| --- | --- |
| `london.jpg` | [Unsplash](https://images.unsplash.com/photo-1513635269975-59663e0ac1ad) |
| `san-francisco.jpg` | [Unsplash](https://images.unsplash.com/photo-1501594907352-04cda38ebc29) |
| `berlin.jpg` | [Unsplash](https://images.unsplash.com/photo-1560969184-10fe8719e047) |
| `amsterdam.jpg` | [Unsplash](https://images.unsplash.com/photo-1534351590666-13e3e96b5017) |
| `new-york.jpg` | [Unsplash](https://images.unsplash.com/photo-1534430480872-3498386e7856) |
| `paris.jpg` | [Unsplash](https://images.unsplash.com/photo-1502602898657-3e91760cbb34) |
| `seattle.jpg` | [Unsplash](https://images.unsplash.com/photo-1502175353174-a7a70e73b362) |
| `singapore.jpg` | [Unsplash](https://images.unsplash.com/photo-1525625293386-3f8f99389edd) |
| `seoul.jpg` | [Unsplash](https://images.unsplash.com/photo-1517154421773-0529f29ea451) |
| `tokyo.jpg` | [Unsplash](https://images.unsplash.com/photo-1536098561742-ca998e48cbcc) |
| `sydney.jpg` | [Unsplash](https://images.unsplash.com/photo-1506973035872-a4ec16b8e8d9) |
| `toronto.jpg` | [Unsplash](https://images.unsplash.com/photo-1517090504586-fde19ea6066f) |

## 글꼴과 아이콘

- Geist, JetBrains Mono, Noto Sans KR: Fontsource 패키지를 통해 로컬 제공. SIL Open Font License.
- [Lucide](https://lucide.dev/): ISC.
- ORBIT 심볼과 회사 이니셜 배지는 직접 작성한 SVG/CSS입니다.

## 이력서 처리

- [PDF.js](https://github.com/mozilla/pdf.js): Apache-2.0. CMap, 표준 글꼴, WASM 자산과 각 라이선스를 패키지에서 로컬로 복사합니다.
- [Mammoth](https://github.com/mwilliamson/mammoth.js): BSD-2-Clause.
- 테스트 이력서는 가상의 이름과 경력으로 작성했습니다.

## 채용 데이터

- [Greenhouse Job Board API](https://developers.greenhouse.io/job-board.html): 회사별 공개 채용 게시판.
- 원문 URL, 조회 시각, 회사와 근무지를 보존합니다. 공개 게시 여부는 조회 시점의 상태입니다.
- 샘플 데이터는 ORBIT의 기능 체험용으로 작성한 가상 시나리오입니다.
