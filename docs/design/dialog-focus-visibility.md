# 대화상자 키보드 초점 가시성

계약 버전: **D2 — 제품 설계 후보 01**  
기준 커밋: `d96367ba9e06ad32737250a482c662e11b7881be`  
단계: 81 / 작성일: 2026-10-03

같은 최종 문서 해시에 Main·GPT-6 Astra Max·Claude Code Fable 5.1 Max가 `DESIGN_APPROVED`를 명시해야 제품·최종 테스트 작성으로 넘어갑니다. 이 후보는 설계 승인이나 구현·검증 통과를 뜻하지 않습니다. D1과 실패 실행, 원래 제안 및 철회한 의견은 단계 근거에 그대로 보존합니다.

## 실제 기준 실행과 선택 근거

제품 코드를 바꾸지 않은 D1에서 Chromium의 실제 Tab/Shift+Tab 이동을 검사했습니다. 10개 사례 중7개가 실패하고3개가 통과했습니다. 가상 자료만 사용했고 검사 중 가시성 보정용 focus/스크롤은 하지 않았습니다. 공고 상세의 일부 링크·원문·메모·안내 조작이 sticky footer 뒤에 가려졌고, 위쪽 경계에서 control/표시가 잘리는 별도 사례도 있었습니다. 이미 메모에 초점이 있는 상태로 viewport를 줄인 직후에는 메모가 화면 밖에 남았습니다.

짧은 화면의 메모는 오류 전 Tab 진입 때부터 가려져 있었으므로 오류 안내만을 원인으로 단정하지 않습니다. 이 문제가80단계에서 처음 생겼다고도 주장하지 않습니다. 257개 관찰 중39개에서 표시 조건을 충족하지 못했습니다. assertion 대상 실패 label은128개, 당시 기록 전용 상태의 label은14개입니다. 이 숫자는 서로 다른 제품 결함 수가 아닙니다.

세 K3 백업 사례는 모두 통과했습니다. 좁은 백업 footer는 삭제 확인 상태에서103.8px→99.8px로 줄었으며, 글자 확대나 footer 성장을 입증한 실행은 아닙니다. 일부 마지막 값 검사는 앞선 aggregate assertion 실패 뒤 실행되지 않았습니다. 세 참여자는 전체 일반/구조화 결과와 이 한계를 확인했습니다.

기준 소스·테스트 digest는 `3dd350ce2a0da964189e498c34c90e37955523d0ad5aa04c390f9b303f91f665`(452개 파일), D1 SHA256은 `0120a5324d51d613319b8886689504f13cc91b3866e17bf97356b123f55ce2d5`입니다. 실행 ID는 `20261002T172220100112Z-b318530e`, 결과 합의 `baseline-evidence-gate-01.json` SHA256은 `37b525346ff2352b6795d527b3aa0de8e07dfe00232fb37a923796f4907916ca`입니다. 이 기준 실행을 다시 돌려 실패 이력을 덮어쓰지 않습니다.

세 독립 제안을 교환한 뒤 native dialog·스크롤 소유권을 유지하는 측정 여유와 실제 가림의 최소 이동을 선택했습니다. CSS 여유만으로 이미 초점이 있는 요소의 크기 변화를 해결한다고 가정하지 않습니다. 임의의 큰 하단 여백, 큰 영역의 일부 두 줄로 전체 읽기를 대신하는 방안, 근거 없는 Undo 여백 제거, 모든 늦은 결과 이후의 현재 초점 보호까지 막는 방안은 선택하지 않았습니다. 마지막 방안의 철회는 S2 합의로 명시했으며 원래 의견도 보존합니다.

## 공식 근거


2026-10-03 KST에 공개 문서를 직접 조회했습니다. URL·조회 시각·응답 본문 해시는 단계 증거에 기록합니다.

- [WCAG 2.4.11 Focus Not Obscured (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html): AA 기준은 초점 요소가 작성자 콘텐츠에 **완전히** 가려지는 것을 금지합니다. 일부 겹침만으로 이 기준 위반이라고 주장하지 않습니다.
- [WCAG 2.4.12 Focus Not Obscured (Enhanced)](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-enhanced.html): AAA 기준은 요소의 일부도 작성자 콘텐츠에 가려지지 않도록 합니다. 요소 바깥의 초점 표시까지를 이 기준의 요소 사각형에 포함하지는 않습니다. 이 프로젝트의 아래 요구는 조작 요소와 초점 표시를 모두 고려하며, WCAG 적합성 인증을 주장하지 않습니다.
- [W3C C43: Using CSS scroll-padding to un-obscure content](https://www.w3.org/WAI/WCAG22/Techniques/css/C43): 실제 고정 영역의 크기를 ResizeObserver로 측정해 scroll-padding에 반영하는 예를 제시합니다. 좁은 화면에서는 고정을 해제하는 대안도 포함합니다. 이 기법이 모든 상황의 초점 가시성을 보장하는 것은 아닙니다.
- [W3C C34: Un-fixing sticky headers / footers](https://www.w3.org/WAI/WCAG22/Techniques/css/C34): 낮은 화면이나 확대 상태에서 고정 영역이 공간을 지나치게 차지할 때 가용 높이에 따라 고정을 해제하는 접근을 설명합니다. 정방향·역방향 키보드 이동에서 초점이 고정 영역 뒤로 숨는 위험도 지적합니다.
- [APG Modal Dialog Example](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/examples/dialog/): 초점 표시, Tab 순환, Escape, 닫기 후 복귀와 긴 내용에서의 초기 초점 위치를 함께 고려합니다. 이 프로젝트의 기존 Close 우선 초점은 유지합니다.
- [MDN scroll-padding-bottom](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/scroll-padding-bottom): 스크롤 컨테이너의 최적 표시 영역을 지정하는 비상속 속성입니다. 스크롤 가능한 공간을 추가하거나 이미 초점이 있는 요소를 자동으로 재배치한다는 보장은 없습니다.


- [CSS Scroll Snap의 scroll-padding 정의](https://drafts.csswg.org/css-scroll-snap-1/#scroll-padding): 최적 표시 영역을 정의하는 비상속·비배치 속성입니다. 초기 위치나 이미 초점이 있는 target의 자동 보정 보장이 아닙니다.
- [HTML의 focus 처리](https://html.spec.whatwg.org/multipage/interaction.html#focus): 명시적 focus API와 순차적 키보드 이동을 동일한 스크롤 정렬 호출로 간주하지 않습니다. focus 자체를 반복해 reveal하지 않습니다.
- [WCAG 1.4.4 Resize Text](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html): 실제 글자200% 확대에서 내용·기능 손실을 검사합니다. 작성 글꼴 시험과 네이티브 확대·OS 설정은 구분합니다.
- [WCAG 2.1.1 Keyboard](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html): 내용과 조작을 키보드로 사용할 수 있어야 합니다. 일부 줄 관찰이나 세 번의 방향키로 전체 읽기를 입증하지 않습니다.

## 사용자 관점의 요구사항


D1의 사용자 요구를 유지합니다. D2의 구현 및 최종 검증은 아직 실행하지 않았습니다.

1. 실제 키보드로 대화상자를 열면 기존과 같이 Close에 초점이 옵니다. 일반 Tab/Shift+Tab 이동의 각 정지점에서, 가용 영역에 들어가는 일반 조작 요소와 초점 표시가 보이고 footer에 가려지지 않아야 합니다. footer 안의 버튼은 footer 내부에서 보이면 됩니다.
2. 표시 여부는 뷰포트와 실제 클리핑 조상, footer 사각형, 여러 지점의 hit test로 판단합니다. 화면 안에 있다는 사실이나 가운데 한 점만 통과한 결과로 일부 가림을 놓치지 않습니다. 토글은 1px 투명 input 대신 실제 표시되는 트랙과 그 초점 표시를 검사합니다.
3. 측정 전에 테스트의 `focus`, locator 자동 스크롤, `scrollIntoView`, 직접 `scrollTop` 수정, 화면 캡처용 프레이밍으로 초점을 보정하지 않습니다. 파일 선택·데이터 주입 같은 시험 준비와 키보드 검증 구간을 명확히 분리합니다.
4. 오류 안내·footer 줄바꿈·뷰포트 변경처럼 실제 기하가 달라질 때에도 초점·메모·선택 영역을 보존합니다. 새로 가려진 요소의 가시성을 위한 필요한 조정과 변화 없는 신호에 대한 스크롤 이동을 구분합니다. 이미 보이는 초점에는 불필요한 스크롤을 하지 않습니다.
5. 저장 실패 초안이 안정된 T0 이후 내용이 바뀌지 않은 복귀 신호에서는 기존 검사의 초점·사각형·내용 offset·`dialog.scrollTop` 0.5px 허용 오차와 쓰기 재시도 금지를 유지합니다. 새 검사 통과를 위해 기존 기대값을 낮추지 않습니다.
6. Undo/재시도/복구 등 modal 피드백 조작은 실제 열린 최상위 modal에 있고 키보드로 접근할 수 있어야 합니다. 조작 결과가 늦게 도착하더라도 이후 사용자가 옮긴 초점·수동 스크롤이나 교체된 modal을 덮어쓰지 않습니다.
7. Escape·Close·배경 클릭, 백업 작업 중 닫기 제한, 연결된 opener 또는 기존 대체 대상 복귀, 배경 스크롤 잠금, 저장 목록의 필터·페이지·초안을 유지합니다.
8. footer가 없는 프로필·데이터 창에는 불필요한 하단 여백이나 새로운 스크롤 이동을 만들지 않습니다.
9. 긴 원문·가져온 메모처럼 내부 스크롤이 있는 영역은 키보드로 읽고 Tab으로 빠져나올 수 있어야 합니다. 내부 읽기 중 바깥 창을 반복해서 가운데로 정렬하거나 배경을 스크롤하지 않습니다.
10. 가용 영역보다 큰 요소 전체를 한 번에 표시하는 것은 물리적으로 불가능합니다. 일반 크기 요소의 완전한 표시 조건은 유지합니다. 큰 영역은 진입 위치의 초점/읽기·편집 맥락이 보이고, 키보드·수동 스크롤로 모든 내용과 다음 조작에 접근할 수 있어야 합니다. 사용자에게 임의의 최대 입력 길이·크기 제한을 추가하지 않습니다. 구체적인 큰 영역 처리 방식은 실제 결과를 보고 후속 제품 설계에서 확정합니다.

초점 표시는 요소 종류에 맞게 검사합니다. 현재 일반 버튼/링크 및 토글 트랙은 2px outline과 4px offset을 사용합니다. 저장 메모와 `.field-group` 필드는 outline 대신 `#acd778` 테두리와 2px spread의 box-shadow를 사용합니다. 이 실제 표시를 무시하고 모든 요소에 outline만 요구하지 않습니다. 검사 기준은 실제 렌더링된 요소와 명시한 표시이며, 제품의 footer 여백 변수나 reveal 함수로 기대값을 계산하지 않습니다. 색 대비 적합성이나 화면을 측정하지 않은 약한 표시를 별도 결함으로 단정하지 않습니다.


## 선택한 구조와 범위

native dialog와 현재 dialog 자체의 세로 스크롤 소유권을 유지합니다. 실제 footer 높이에 맞춘 scroll-padding과 가려진 현재 조작만 드러내는 최소 이동을 함께 사용합니다. 긴 읽기·편집 영역은 내용을 보존한 내부 스크롤 viewport로 표시합니다. 필요한 공간이 부족하면 footer를 같은 DOM 순서의 일반 흐름으로 전환합니다.

제품 수정 범위는 `ui.tsx`, 새 `src/lib/dialog-visibility.ts`, `DialogFeedback.tsx`, `SavedDataDialog.tsx`, `styles.css`, `ProfileDialog.tsx`의 파일 input 한 속성입니다. 저장 트랜잭션·수집/API·프로필 자료 구조를 바꾸지 않습니다. 기존 Undo 버튼20px/100px 여백은 유지합니다. 별도 스크롤 컨테이너로 구조를 바꾸거나 입력 길이를 줄이지 않습니다.

Profile의 clip rect0 파일 input은 `tabIndex={-1}`로 중복된 보이지 않는 정지점을 없앱니다. 기존 보이는 upload button의 Enter→파일 선택, label 기반 가져오기, drag/drop과 입력 제한은 유지합니다. 이 항목은 정적 소스 위험에서 선택한 수정이며, 이전 실행에서 재현한 새 실패라고 기록하지 않습니다.

## 표시와 이동

기본 영역은 실제 dialog client box와 viewport의 교집합입니다. 본문 target에는 겹치는 sticky footer를 제외하고, footer target에는 자기 footer를 가림 요소로 제외하지 않습니다. 토글의 실제 표시 대상은 인접한 track이며 입력의 초점과 checkbox 의미는 유지합니다.

8px는 현재 일반 outline2px+offset4px를 포함하는 목표 여유입니다. CSS scroll-padding에는 노출된 위쪽8px, 아래쪽 footer 기여+8px를 줍니다. footer가 없으면 기여가0이고, 일반 흐름이면 sticky 기여가0입니다. spacer나 별도 본문 padding을 추가하지 않습니다. 실제 control과 그려진 표시가 이미 모두 보이면 추가2px를 만들려고 스크롤하지 않습니다. 가려진 경우에만8px를 포함한 target을 가까운 경계 안으로 최소 이동하며 여유를 두 번 더하지 않습니다.

수정은 dialog 소유 스크롤만 즉시 이동하며, focus/selection/value나 내부 reader/editor 스크롤을 다시 쓰지 않습니다. 가로 넘침은 wrapping/layout으로 해결하고 세로 보정 반복으로 숨기지 않습니다. 실제 스크롤 한계에 막힌 가림은 검사에서 그대로 실패해야 합니다. 테스트는 제품 변수·보정 함수나 threshold 식을 기대값 생성기로 사용하지 않습니다.

## 읽기·편집 높이와 공간 부족

C는 현재 내용 높이에 좌우되지 않는 최대 client 수용 높이입니다. 실제 적용된 max-height/viewport 제한과 테두리·가로 scrollbar를 반영합니다. CSS의 desktop64px, mobile32px, SavedData640px 이하32px 기준을 일관되게 사용합니다. 예를 들어320×480에서는 최대 border box448px에서 테두리2px을 뺀 C=446px입니다. 실제 reveal은 별도로 현재 viewport-clipped client box를 사용합니다.

F는 현재 폭의 footer 자연 border-box 높이입니다. sticky offset에 의존하지 않습니다. `Usticky=C−F−16`, `Uflow=C−16`입니다. 원문420px·백업 메모180px·백업 본문/pre220px의 기존 상한과 선택된 U 중 작은 값으로 내부 viewport를 제한합니다. 저장 메모는 U로 표시 높이를 제한하면서 native vertical resize 요청·모든 내용·선택·기존 입력 길이 제한을 보존합니다. 큰 폭/높이로 돌아오면 요청한 inline 높이를 다시 사용할 수 있습니다. Profile 필드의 기존100px/270px 제약을 임의로 덮어쓰지 않습니다.

각 렌더링된 관리 대상 reader/editor의 R은 실제 두 줄 높이와 block padding/border의 합입니다. `Usticky<R`인 대상이 있거나, 일반 활성 본문 조작이 Uflow에는 들어가지만 Usticky에는 들어가지 못하면 footer를 일반 흐름으로 바꿉니다. R을 CSS min-height로 주어 실제 가용 cap을 넘어가게 하지 않습니다. footer의 흐름상 공간과 순서는 유지합니다.

일반 흐름 전환은 viewport·글꼴·footer 내용/폭 변화 같은 외부 크기 원인이 생길 때까지 유지합니다. 모드 자체의 크기 알림이나 Tab만으로 sticky↔flow를 반복하지 않습니다. 복귀 판단은 가상의 sticky 점유를 다시 계산합니다. flow에도 들어가지 않는 요소를 정상 표시로 주장하지 않고, 무한 보정이 없어야 합니다.320×320의 실제200% 글꼴 사례로 충분한 크기 변화와 복귀, 전체 읽기·footer 접근을 확인합니다. 검사는 threshold를 복사하지 않고 실제 부족 공간·문장·조작 표시를 확인합니다.

footer 버튼과 링크, 백업의 중첩 actions는 줄바꿈과 자동 높이를 허용하고 기존44px mobile 최소 높이를 보존합니다. 이후에 선언된 mobile padding/min-width 규칙도 포함해 실제 전체 레이블과 표시가 보여야 합니다.

## 생명주기와 현재 초점 맥락

DialogFeedback의 showModal 순서 registry에서 현재 top owner를 동기적으로 조회하는 안정된 accessor를 제공합니다. 등록·해제 시 provider의 렌더 상태를 게시하기 전에 소유 상태를 갱신합니다. DOM 순서로 topmost를 추정하지 않습니다. 관찰자와 controller는 현재 Dialog의 동일 mount lifetime에서 설치·정리하고, children·draft·callback 변경으로 showModal을 다시 실행하지 않습니다.

초점 진입은 native focusin 뒤 microtask에서 현재 geometry를 확인합니다. 필요한 sizing/mode 게시가 아직 남으면 해당 layout job에 합칩니다. ResizeObserver는 footer/dialog/direct children/active proxy의 변화만 알리고 그 안에서 style·scroll을 쓰지 않습니다. 직접 자식 교체를 통해 새 footer나 Filters alert도 관찰합니다.

변화는 하나의 취소 가능한 frame으로 합칩니다. 변경된 local size/mode를 먼저 게시하고, layout을 바꿨다면 다음 coalesced frame에서 새 사각형을 읽어 reveal합니다. 매번 target·lifetime·top owner·generation을 다시 확인합니다. 같은 값의 style은 다시 쓰지 않고 자기 변경 때문에 영구적인 frame loop를 만들지 않습니다. 초점·입력이나 읽기가 이미 보이는 상태라면 쓰기가 없습니다.

geometry signature는 표시 proxy의 identity/크기/내용 좌표, client/viewport clip, 자연 footer 높이/모드입니다. raw dialog/inner scrollTop 변화 자체를 배치 변화로 쓰지 않습니다.0.5px를 넘는 실제 기하 차이를 구분합니다. window focus/visibilitychange/pageshow는 reveal·저장 retry의 트리거가 아닙니다.

이후 focus, pointer/key 조작, wheel/touch, 선택 gesture, composition은 이전 예약 작업과 action ticket을 무효화할 수 있습니다. 수동 wheel/touch/scrollbar는 수동적 복귀를 중지합니다. 새 명시적인 focus/editor 활동은 새 맥락을 만들 수 있습니다. inner-reader 키 이동은 이전 작업을 무효화하지만 바깥 가운데 정렬을 요청하지 않습니다. inner scroll 자체로 reader를 버렸다고 추정하지 않습니다. composition 도중 보정을 미루고 끝난 뒤 새 현재 맥락으로 확인합니다.

## 늦은 결과 — S2: 현재 맥락 보호와 명시적 목적지 권한

오래된 동작의 명시적인 안내/fallback 목적지 이동과 현재 사용자가 조작 중인 요소의 가시성 보호를 분리합니다. 오래된 action ticket이 invalid/null이면 그 목적지로 scroll/focus하지 않습니다. 결과 메시지 표시와 실제 저장 동작은 계속 정상적으로 반영합니다. observer는 버린 맥락을 rearm하거나 옛 target을 복구하지 않습니다.

새 deliberate focus/editor 맥락이 있다면, 실제 layout 변화 때문에 그 현재 target이 가려졌을 때 최소 보정을 할 수 있습니다. 이는 옛 알림 목적지를 다시 승인하는 것이 아닙니다. 사용자가 수동으로 이동한 뒤 새 맥락을 만들지 않은 경우에는 그 위치를 지킵니다. 이 선택은 전체 content commit에 임의의 최신 action provenance를 붙여서 숨기는 방식이 아닙니다. 세 참여자 모두 S2를 선택했습니다. 이 문서 전체의 승인은 별도로 받습니다.

SavedData는 readFile/refreshReview/apply/discard/exportBackup의 명시적 작업 시작 시 원래 action/lifetime/epoch ticket을 캡처합니다. 메시지/error와 그 요청 ticket·revision을 묶고, 같은 문구의 새 작업도 구분합니다. effect는 결과 revision을 포함해 처리하며, 가변적인 최신 ticket ref에 과거 결과를 연결하지 않습니다. discard 안의 refresh도 원래 조작의 ticket을 전달합니다. 현재 request counter와 저장 연산의 의미는 유지합니다. local clearing/busy/footer 상태는 메시지 목적지를 자동으로 승인하지 않습니다. 백업 오류/완료 결과의 명시적 reveal은 해당 원래 ticket으로만 실행합니다. 페이지 이동은 새 사용자 navigation으로 이전 요청을 무효화하고 수동적인 현재-target 보호를 중지한 뒤, 그 조작의 새 ticket으로 현재 섹션 목적지를 처리합니다.

SavedFeedback은 onAction의 원래 button/job/owner/ticket을 유지합니다. disabled/removed-button fallback은 원래 요청이 여전히 유효할 때에만 기존 목적지를 사용합니다. 유효성 검사는 focus와 scroll 모두의 앞에 적용합니다. invalid ticket으로 preventScroll focus만 남기는 예외도 두지 않습니다. 이후 조작이 없는 정상적인 버튼 소멸에서는 기존 Close/페이지 대상 복귀를 유지합니다. 버튼 소멸 자체를 새로운 사용자 의도로 오인해 정상 복귀를 취소하지 않습니다. 늦은 다른 작업이나 교체 modal에 새 ticket을 붙여 이전 요청을 살리지 않습니다. 연결 지을 수 없는 완료는 명시적 목적지 이동을 허용하지 않습니다.

닫기 후 기존 정상 초점 복귀는 유지합니다. 그 뒤 frame-deferred page reveal은 임시 one-shot wheel/touch/pointer/key guard와 target/modal 확인으로 이후 같은-focus 수동 이동도 존중합니다. 그 frame이 끝나거나 취소되면 임시 guard를 제거합니다. 현재 앱의 페이지 Toast 처리는 이 단계에서 바꾸지 않습니다.


## 공통 권한과 관찰 계약

새 utility는 Dialog controller와 명시적 reveal 호출부의 intent 권한을 공유합니다. 함수 이름은 구현에서 정하되 다음 계약을 지킵니다.

- Action ticket은 원래 origin/action, owner의 mount lifetime, 동기 modal stack 세대와 의도 epoch를 캡처합니다. 페이지 피드백도 page owner로 같은 권한 모델을 사용합니다. 뒤의 상호작용·modal 교체·owner 정리는 ticket을 만료시키며, 완료 핸들러에서 새 ticket을 만들지 않습니다.
- Origin 버튼의 disabled/제거 자체는 새 사용자 의도가 아닙니다. 원래 ticket이 유효하면 복귀가 가능하지만 이후 수동 이동/새 초점이 있으면 focus와 scroll 모두 취소합니다. 원래 owner와 현재 top owner, 목적지의 연결 및 올바른 열린 창 소속을 확인합니다. 유효한 복귀의 focus/scroll은 한 조작으로 수행하며 자체 focus가 중간 권한을 취소하거나 다른 요청을 다시 승인하지 않습니다.
- 현재 초점 맥락은 action ticket과 별개인 target·generation·armed 상태입니다. 새 focus/editor 활동만 다시 armed로 만들 수 있습니다. observer나 늦은 피드백은 target을 선택하거나 맥락을 재활성화하지 못합니다. raw scrollTop만으로 사용자/프로그램 이동을 구분하지 않습니다.
- wheel/touch/scrollbar가 바깥 dialog를 실제로 수동 이동시키는 경우 보호를 중지합니다. 내부 reader/editor를 읽는 이동은 옛 ticket/예약 작업을 취소하되 읽는 맥락은 유지합니다. 해당 키/scroll 이벤트 자체는 outer reveal을 요청하지 않습니다. 일반 조작 위의 PageDown/Space와 textarea의 caret/selection·reader 내부 이동을 구분합니다.
- 입력·selection·composition의 native 동작을 방해하지 않습니다. composition 중에는 보정하지 않고 종료 뒤 현재 상태로 새 확인을 합니다. 같은 글자/선택을 코드로 다시 쓰지 않습니다.
- 관찰·측정·style·scroll과 frame/microtask의 소유권을 mount lifetime에 연결합니다. cleanup 이후 콜백과 교체된 modal은 아무 것도 쓰지 않습니다. 재연결한 observer 및 일회성 페이지 복귀 guard의 listener도 정리합니다.

Action epoch와 engaged context를 분리해 옛 요청을 취소하면서 현재 field의 실제 가림만 고칩니다. 모든 feedback/busy commit을 태깅하는 별도 provenance 상태 체계는 만들지 않습니다.

## 최종 독립 검증의 기대값

Fable은 기존 강한 검사와 D1 자료를 유지하며 E2E를 독립적으로 보강합니다. 제품 utility/CSS 변수로 기대값을 계산하지 않습니다. 실제 사각형·표시·Range 문장·hit test·공개 상태를 조합합니다. 측정 전 테스트 focus/scroll/framing을 하지 않는 구간을 유지하고, 관찰로 입증할 수 없는 부분은 빈틈으로 보고합니다.

| 흐름 | 반드시 확인할 결과 |
| --- | --- |
| K1–K4 | 기존1440×960,320×800,320×480의 native 전후 정지점에서 조작/표시가 보임. K3/K4의 과거 기록 전용 전환 상태도 assertion 대상. 값·초점·선택 수 및 Escape 뒤 기록 보존의 마지막 검사까지 실제 실행. |
| 긴 원문/백업 본문 | native 키보드로 시작·중간·마지막의 서로 다른 literal 문장에 도달해 완전한 줄이 보임. Tab/Shift+Tab 정상 탈출. 내부 읽기 중 바깥 창/배경을 반복 이동하지 않음. |
| 긴/사용자 resize 메모 | native caret으로 처음·중간·끝의 삽입 위치에 도달해 실제 위치가 보임. 비축소 선택의 범위와 literal 편집 결과 유지. 작은 화면/복귀 뒤 내용·선택·가능한 요청 크기 보존. 일부 두 줄만 보이는 예외로 통과시키지 않음. |
| 실제200% 작성 글꼴 | 개별 계산 글자 크기를 모두 먼저 저장한 후200% 적용. 중첩 상속400% 또는 px 자식 미확대를 놓치지 않음. 실제 footer 성장/줄바꿈·전체 레이블·표시·본문 접근. transform/viewport만으로 대체하지 않으며 동적 생성 요소도 확대 조건에 포함. |
| 공간 부족/복귀 |320×320의 실제 확대에서 sticky로 읽기 공간 확보가 불가능한 조건을 실제 측정. 같은 DOM 순서의 flow footer와 전체 내용/조작 접근, 충분한 viewport/글꼴 크기로 복귀 뒤 정상 동작·모드 반복 없음. 제품 threshold 복사만으로 기대값을 만들지 않음. |
| 필터/토글 | native keyboard의 모든 track/표시, 오류·결과 수 변경, 초기화/적용·닫기·값 유지. footer 변화와 직접 자식 alert 삽입 처리. |
| footer 없는 Profile/Data | 보이는 조작의 불필요한 스크롤 없음, 가짜 footer 공간 없음. profile 오류 초점, 보이는 upload 버튼 Enter→chooser, 기존 label 가져오기·drop·입력 제한 유지. 내용/마지막 조작의 키보드 접근. 없는 baseline 수치를 사후에 만들지 않음. |
| 수동 이동 후 늦은 A | 같은 초점으로 수동 이동 후 A가 끝나도 rearm·옛 안내/복귀 focus/scroll 없음. B로 focus/edit를 바꾼 경우도 A 목적지 이동 취소. |
| B 편집 후 A 때문에 실제 가림 | 새 deliberate B 맥락이 있고 A 결과로 B가 가려지는 실제 사례. B만 최소 보정되며 literal 값·초점·선택 유지, A 안내로 이동 없음. 배치 변화/UA anchoring과 stale 이동을 구분하되 변하지 않은 기존 T0/T2는0.5px 유지. |
| 버튼 복귀/닫기 | 유효한 ticket의 버튼 소멸은 기존 복귀. 후속 이동/교체 modal은 focus와 scroll 모두 취소. 같은 focus의 수동 page 이동도 deferred opener reveal 취소. unmount 뒤 쓰기 없음·재열기 정상. |
| 기존 상태·저장 회귀 | Undo, saved-lifecycle, backup 선택/페이지/비교/취소, profile/import, filter·API·페이지. 안정된 실패 초안의 복귀 burst·재시도 금지 유지. 단일 최상위 피드백 소유권·양방향 Tab·닫기/배경 잠금 보존. |

관련 타입·단위 검사와 build, 명시한 관련 development E2E 및 필터 없는 전체 production E2E가 필요합니다. 새 파일을 포함한 최종 목록은 Fable 작성 후 동결합니다. retry0이며 skip으로 실패를 숨기지 않습니다. 일반/JSON 보고서를 함께 남기고 실패 원본을 보존한 후 세 참여자가 원인·수정에 합의해야 영향을 받는 검사를 재실행합니다.

Chromium과200% 작성 글꼴 시험은 네이티브 확대·실제 모바일 키보드·OS 글자·다른 브라우저·스크린리더 검증이 아닙니다. 최종 전체 실행 전에는 정상 구현으로 보고하지 않습니다.

## 실행 전과 실행 후

Fable만 tests/로컬 검증 자료를 작성하고 app/compiler/test/build/browser/server/setup을 실행합니다. Main은 제품·통합·문서, Astra는 읽기 전용 검토를 맡습니다. 최종 공통 D2 해시의 세 DESIGN_APPROVED 이후 작성하고, 최종 source/test/plan 해시의 세 IMPLEMENTATION_REVIEW_APPROVED 이후 실행합니다.

기존 K1–K4의 모든 assertion과 모든 전환 상태, 기존 Undo·saved-lifecycle·backup·profile/import·focus/restore·API/페이지 회귀를 유지합니다. 별도의200% 작성 글자 시험, 전체 내용/실제 caret/비축소 selection, 토글 오류/결과 수, 프로필 picker, 수동 scroll·현재 입력·늦은 결과·교체 modal·cleanup을 보강합니다. 관련 check/unit/build/개발 E2E와 전체 unrestricted production E2E를 완결합니다.

일반/구조화 보고서를 함께 확인하며 실패·생략·전역 오류·환경 메시지·후속 미실행 assertion을 숨기지 않습니다. 실행용 전원 프로세스는 만료 시간·소유자·전후 상태를 기록합니다. 실제 최종 세 검증 합의 후 commit/push, 가치 있는 local 근거의 Git 보존/readback, 소유 프로세스와 재현 가능한 임시 자료 정리, 실제 cleanup 문서 commit을 순서대로 마칩니다. 보호 대상44개 원본/관측은 보존합니다.
