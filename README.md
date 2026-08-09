# Tasks Ancestor View

Obsidian Tasks 플러그인의 컴패니언 플러그인입니다.
DSL 쿼리 결과에서 **매칭된 태스크의 조상(부모) 체인**을 트리 형태로 표시합니다.

---

## 왜 이 플러그인이 필요한가?

Obsidian Tasks 플러그인의 쿼리 결과는 **플랫(flat)** 합니다.

```
- [ ] #task batch 📅 2026-03-11
- [ ] #task batch2 📅 2026-03-11
```

원본 노트에서 이 태스크들은 깊은 계층 구조 안에 있지만, 쿼리 결과만 보면 어떤 프로젝트/맥락에 속하는지 알 수 없습니다.

Tasks 플러그인의 `show tree` 옵션은 **자식(children)** 만 펼쳐서 보여줄 뿐, **부모(ancestors)** 는 보여주지 않습니다.

이 플러그인은 그 gap을 메웁니다:

```
- [ ] 월간 보고 🛫 2026-03-04 📅 2026-03-31          ← 조상 (자동 생성)
    - A 그룹                                          ← 조상 (일반 리스트 항목)
        - [ ] #task 배치 준비                          ← 조상
            - [ ] #task batch 📅 2026-03-11            ← ★ 매칭된 태스크
    - B 그룹
        - [ ] #task 배치 준비
            - [ ] #task batch2 📅 2026-03-11           ← ★ 매칭된 태스크
```

---

## 요구 사항

| 항목 | 내용 |
|------|------|
| Obsidian | v1.4.0 이상 |
| Tasks 플러그인 | 설치 및 활성화 필수 (`obsidian-tasks-plugin`) |

---

## 설치 방법

### 수동 설치

1. Vault의 `.obsidian/plugins/` 폴더 아래에 `tasks-ancestor-view` 폴더를 생성합니다.
2. 아래 3개 파일을 해당 폴더에 복사합니다:

```
.obsidian/plugins/tasks-ancestor-view/
├── main.js
├── manifest.json
└── styles.css
```

3. Obsidian을 재시작합니다.
4. **설정 → 커뮤니티 플러그인**에서 "Tasks Ancestor View"를 활성화합니다.

---

## 사용법

노트에서 `tasks` 대신 `tasks-ancestors` 코드블록을 사용합니다.
쿼리 문법은 Tasks 플러그인 DSL과 **100% 동일**합니다.

````markdown
```tasks-ancestors
not done
due today
```
````

````markdown
```tasks-ancestors
not done
due before tomorrow
filename does not include daily
sort by due
group by filename
```
````

기존 `tasks` 코드블록에서 블록 이름만 `tasks-ancestors`로 바꾸면 됩니다.

### 조상 항목 클릭 → 원본으로 이동

회색으로 표시되는 조상 항목의 **텍스트를 클릭**하면 그 항목이 적힌 원본 노트의
해당 줄로 이동합니다. 매칭된 태스크의 백링크와 같은 제스처를 씁니다:

| 제스처 | 동작 |
|--------|------|
| 클릭 | 현재 탭에서 열기 |
| Ctrl/Cmd + 클릭 | 이미 열려 있으면 **그 탭으로 이동**, 아니면 새 탭 |
| 가운데 클릭 | 이미 열려 있으면 **그 탭으로 이동**, 아니면 새 탭 |

탭 재사용은 **메인 워크스페이스만** 봅니다. 사이드바나 별도 창(팝아웃)에 같은
노트가 열려 있어도 그쪽으로 포커스를 넘기지 않고 새 탭을 엽니다 — 클릭 한 번에
다른 창으로 화면이 넘어가는 것보다 탭이 하나 더 생기는 편이 덜 놀랍기 때문입니다.
같은 노트가 여러 탭에 열려 있으면 가장 최근에 쓴 탭으로 가되, Obsidian이
공개하는 최근 정보가 탭 하나뿐이라 그게 후보에 없으면 탭 순서상 첫 번째로 갑니다.

조상 텍스트 안의 태그·링크는 원래대로 자기 동작을 유지합니다(태그 클릭 = 태그 검색).
줄 번호는 Tasks가 마지막으로 파싱한 시점의 값이라, 그 사이 파일 위쪽이 편집됐으면
어긋날 수 있습니다. 그래서 이동 전에 **원문이 그 줄에 그대로 있는지 확인**하고,
아니면 파일 안에서 원문이 유일하게 일치하는 줄을 찾습니다. 동일한 줄이 여럿이면
고르지 않고 기록된 줄로 갑니다.

---

## 설정

**설정 → 커뮤니티 플러그인 → Tasks Ancestor View**

| 항목 | 기본값 | 설명 |
|------|--------|------|
| 하위 항목도 함께 표시 | 켜짐 | 매칭된 태스크 **아래**에 달린 항목(`#task`가 아닌 체크박스·일반 목록)까지 트리에 펼칩니다. 끄면 조상 체인만 남습니다. |
| 조상 클릭 시 원본으로 이동 | 켜짐 | 끄면 조상 텍스트가 클릭에 반응하지 않고 커서도 바뀌지 않습니다. |
| 재구성 대기 시간 | 400ms | Tasks가 목록을 다시 그린 뒤 트리를 재구성하기까지의 대기. 50~5000 범위로 보정됩니다. |
| 디버그 로그 | 꺼짐 | 매칭 결과와 소요 시간을 콘솔에 출력합니다. |

설정을 바꾸면 **열려 있는 노트가 즉시 다시 그려집니다** — 노트를 다시 열 필요 없습니다.

---

## 동작 원리

```
┌─────────────────────────────────────────────────────────┐
│  tasks-ancestors 코드블록 감지                            │
└──────────────────────┬──────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────┐
│  1. Tasks 플러그인에 쿼리 위임 (플랫 렌더)                  │
│     → addQueryRenderChild(source, el, ctx)               │
│     → Tasks DSL 100% 호환 (필터, 정렬, 그룹 등)            │
└──────────────────────┬──────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────┐
│  2. 렌더 완료 감지 (MutationObserver, 400ms debounce)     │
└──────────────────────┬──────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────┐
│  3. 매칭: 렌더된 <li> ↔ Task 객체                         │
│     → getTasks() 결과를 1회 인덱싱 (id / 설명 / 파일명)      │
│     → 1차: 🆔 완전일치(결정적) / 2차: 텍스트 + 백링크        │
└──────────────────────┬──────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────┐
│  4. 조상 트리 구축                                        │
│     → 매칭된 Task의 .parent 체인을 root까지 순회            │
│     → 공유 조상은 병합 (객체 참조로 비교)                    │
└──────────────────────┬──────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────┐
│  5. DOM 재구성                                            │
│     → 매칭 태스크: 원본 <li> 이동 (이벤트 핸들러 보존)        │
│     → 조상 항목: 새 <li> 생성 (읽기전용 체크박스)             │
└─────────────────────────────────────────────────────────┘
```

### 핵심 설계 결정

| 결정 | 이유 |
|------|------|
| Tasks 플러그인에 렌더를 위임 | DSL 100% 호환. 자체 파서 불필요. Tasks 업데이트 시에도 자동 호환 |
| 원본 `<li>` 이동 (clone 아님) | 체크박스 토글, 백링크 클릭 등 Tasks 이벤트 핸들러가 모두 보존됨 |
| 조상 `<li>`는 readOnly/disabled | 조상은 쿼리 매칭 결과가 아니므로 직접 조작 방지 |
| prototype 패턴 (ES6 class 아님) | Obsidian CJS 번들 호환성 |
| MutationObserver disconnect/reconnect | 자체 DOM 수정이 observer를 재트리거하는 무한루프 방지 |

---

## 파일 구조

```
tasks-ancestor-view/
├── main.js                  ← 플러그인 전체 로직 (단일 파일, 빌드 불필요)
├── manifest.json            ← Obsidian 플러그인 메타데이터
├── styles.css               ← 스타일시트
├── package.json             ← 테스트 스크립트만 (의존성 없음)
├── tests/matching.test.js   ← 매칭 순수함수 단위 테스트
├── tests/navigation.test.js ← 위치 해석 순수함수 단위 테스트
├── tests/settings.test.js   ← 설정 병합 순수함수 단위 테스트
└── README.md                ← 이 문서
```

릴리스 산출물은 `main.js` / `manifest.json` / `styles.css` / `versions.json` 4개입니다.
`tests/`와 `package.json`은 저장소에만 있고 배포되지 않습니다.

### main.js 내부 구조

```
TasksAncestorPlugin (extends obsidian.Plugin)
│
├── onload()
│   └── registerMarkdownCodeBlockProcessor('tasks-ancestors')
│       └── AncestorRenderChild 생성
│
└── AncestorRenderChild (extends obsidian.MarkdownRenderChild)
    │
    ├── onload()           → Tasks 플러그인 확인 → 플랫 렌더 요청 → Observer 시작
    ├── onunload()         → Observer 해제, 타이머 정리
    │
    ├── _processResults()  → Observer 콜백 (debounced)
    ├── _doProcess()       → 인덱스 1회 구축 → 전체 <ul> 순회
    ├── _processOneUl()    → 잔재 제거 → 2-pass 매칭 → 트리 구축 → DOM 재구성
    │
    ├── _pickById()        → 🆔 완전일치 (결정적, 백링크로 tiebreak)
    ├── _pickByText()      → 설명 완전일치 fast path → 전체 스캔
    ├── _bestOf()          → 후보 풀에서 최고 점수 선택
    ├── _buildTree()       → parent 체인 → 가상 트리 노드 구축
    ├── _renderTree()      → 가상 트리 → DOM 렌더링
    ├── _createAncestorLi()→ 조상 항목 <li> 생성 (+ 클릭 핸들러)
    ├── _openSource()      → 원본 파일 열고 해당 줄로 이동
    └── forceReprocess()   → 설정 변경 시 강제 재구성

AncestorSettingTab (extends obsidian.PluginSettingTab)
    └── display()          → 설정 4개. 입력 중 재렌더하지 않는다(포커스 유실 방지)
```

모듈 최상위의 순수함수(`stripCheckbox` `normalizeWS` `plainify` `itemKey`
`itemLocation` `resolveLine` `backlinkBonus` `scoreEntry` `buildIndex`
`clampDebounce` `mergeSettings` `findOpenLeaf`)는 `exports._internals`로 노출되어
`npm test`에서 검증됩니다. Obsidian은 `exports.default`만 읽으므로 영향이 없습니다.

---

## 제한 사항 및 알려진 이슈

| 항목 | 설명 |
|------|------|
| 조상 항목 인터랙션 | 조상 `<li>`의 체크박스는 읽기전용입니다. 토글하려면 텍스트를 클릭해 원본으로 이동한 뒤 수정하세요. |
| 조상 이동 대상 | 위치를 못 읽는 항목(`taskLocation` 없음)은 클릭해도 반응하지 않습니다. 커서가 바뀌지 않는 항목이 그렇습니다. |
| 텍스트 매칭 한계 | 🆔가 있는 태스크는 결정적으로 매칭됩니다. 🆔가 없고 동일한 설명의 태스크가 여러 파일에 있으면 잘못 매칭될 수 있습니다(백링크 파일명·헤딩으로 보정하지만 100%는 아닙니다). |
| Global Filter | Tasks 플러그인의 Global Filter가 설정되어 있으면 렌더된 텍스트와 원본 마크다운 간 차이가 발생할 수 있습니다. |
| 조상 렌더링 | 조상 항목은 plain text로 표시됩니다. Tasks 플러그인처럼 날짜 이모지나 우선순위 표시는 제공하지 않습니다. |

---

## 커스터마이징 (CSS)

`styles.css` 또는 Obsidian CSS snippet으로 조상 항목의 스타일을 변경할 수 있습니다.

```css
/* 조상 항목 전체 */
.tasks-ancestor-item {
    opacity: 0.7;
}

/* 조상 항목의 텍스트 */
.tasks-ancestor-label {
    font-style: italic;
    color: var(--text-muted);
}

/* 조상 체크박스 숨기기 (원하는 경우) */
.tasks-ancestor-item .task-list-item-checkbox {
    display: none;
}

/* 클릭해서 원본으로 갈 수 있는 조상만 별도 표시 */
.tasks-ancestor-clickable .tasks-ancestor-label:hover {
    color: var(--text-accent);
}
```

---

## Tasks 플러그인과의 관계

```
┌──────────────────────┐     ┌──────────────────────────┐
│  Tasks Plugin        │     │  Tasks Ancestor View     │
│  (obsidian-tasks)    │     │  (이 플러그인)              │
│                      │     │                          │
│  • DSL 쿼리 엔진     │◄────│  쿼리 위임                 │
│  • Task 캐시         │◄────│  getTasks() 호출           │
│  • 렌더링 엔진       │◄────│  addQueryRenderChild()    │
│  • 이벤트 핸들러     │     │                          │
│                      │     │  • 조상 트리 구축          │
│                      │     │  • DOM 재구성              │
└──────────────────────┘     └──────────────────────────┘

의존 방향: Tasks Ancestor View → Tasks Plugin (단방향)
Tasks 플러그인은 이 플러그인의 존재를 모릅니다.
Tasks 플러그인 업데이트 시 이 플러그인에 영향 없습니다.
(getTasks(), addQueryRenderChild() 공개 API가 유지되는 한)
```

---

## 개발 참고

이 플러그인은 빌드 시스템 없이 **순수 JavaScript 단일 파일**로 작성되었습니다.

- TypeScript, esbuild, npm 등 불필요
- `main.js`를 직접 편집하면 됩니다
- Obsidian 재시작 또는 플러그인 비활성화/활성화로 변경 사항 반영

### 디버깅

로그는 기본적으로 꺼져 있습니다(재렌더마다 출력되므로). **설정의 "디버그 로그"** 를
켜는 게 가장 간단하고, 설정을 열기 어려운 기기에서는 개발자 도구(Ctrl+Shift+I)
콘솔에서 켠 뒤 노트를 다시 열어도 됩니다:

```javascript
localStorage.setItem('tav-debug', '1');   // 끄기: localStorage.removeItem('tav-debug')
```

```
Tasks Ancestor View v2.1.0: loaded
Tasks Ancestor View v2.1.0: requesting flat render
Tasks Ancestor View v2.1.0: processing 1 task list(s); indexed 2293/2400 tasks in 12ms
Tasks Ancestor View v2.1.0: matched=5  unmatched=0  in 3ms
```

`console.error`(처리 오류)는 플래그와 무관하게 항상 출력됩니다.

### 테스트

```bash
npm test          # node --test tests/  (의존성 설치 불필요)
npm run check     # node --check main.js
```

릴리스 워크플로도 같은 명령을 실행하며, 태그와 `manifest.json`의 `version`이
어긋나거나 `versions.json`에 해당 항목이 없으면 릴리스를 만들지 않고 실패합니다.

### 사용하는 Tasks 플러그인 내부 API

```javascript
// Task 목록 조회 (parent/children 관계 포함)
app.plugins.plugins['obsidian-tasks-plugin'].getTasks()

// 쿼리 렌더 위임 (DSL 100% 호환)
app.plugins.plugins['obsidian-tasks-plugin'].queryRenderer.addQueryRenderChild(source, el, ctx)
```

> **주의**: 이 API들은 Tasks 플러그인의 공식 외부 API가 아닌 내부 공개 멤버입니다.
> Tasks 플러그인 메이저 업데이트 시 변경될 수 있으나, 현재까지 안정적으로 유지되고 있습니다.

---

## 라이선스

MIT

---

## 버전 히스토리

| 버전 | 날짜 | 변경 사항 |
|------|------|----------|
| 2.4.0 | 2026-08 | 새 탭 제스처가 이미 열려 있는 탭을 재사용(메인 워크스페이스 한정) |
| 2.3.0 | 2026-08 | 설정 탭(하위 항목 표시·클릭 이동·대기 시간·디버그 로그), 설정 변경 시 즉시 재구성, 재구성 시 트리를 평면으로 되돌리도록 수정 |
| 2.2.0 | 2026-08 | 조상 항목 클릭 → 원본 줄로 이동(Ctrl/가운데 클릭 지원, 원문 대조로 줄 번호 보정) |
| 2.1.0 | 2026-08 | 🆔 우선 2-pass 매칭, 마크다운 링크 설명 정규화, 중첩 `<li>` 오염·조상 잔재 누적·언로드 시 observer 누수 수정, 매칭 인덱스화, 순수함수 테스트 추가 |
| 2.0.2 | 2026-07 | 🆔 결정적 매칭(중복 렌더 수정), BRAT 독립 저장소 전환 |
| 2.0.0 | 2026-03 | 전면 재설계: Tasks 렌더 위임 + parent 체인 순회 방식 |
| 1.1.0 | 2026-03 | CJS 호환 수정, MutationObserver 무한루프 수정 |
| 1.0.0 | 2026-03 | 최초 버전 (dual-render 방식, 폐기됨) |
