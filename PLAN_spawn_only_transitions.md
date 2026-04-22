# Plan: Stitch-based dynamic transitions (DAG-only)

Branch: `feat/spawn-only-review`

> 파일 이름은 레거시. 내용상으로는 "spawn"이 아니라 **stitch** 기반. sub-process로 pipeline을 띄우는 게 아니라 현재 pipeline의 stage 그래프에 **동적으로 부분그래프를 끼워넣는** 방식.

## 철학

- Pipeline은 **DAG**. 사이클 금지.
- "루프"가 필요하면 같은 종류의 스테이지를 **downstream에 새로 insert**. 원본 노드로 돌아가지 않음.
- 동적 확장은 런타임에 그래프를 **아래로** 키우는 방식. 재귀/프로세스 중첩 없음.
- Breaking change. 구버전 PIPELINE.json / state 파일 호환성 없음.

## 핵심 개념

### 통합 transition schema

```jsonc
{ "marker": "<MARKER>", "next": "<node_or_template>", "count"?: N }
```

- `next`는 **노드 이름** 또는 **템플릿 이름**.
- 노드 이름이면 → 그 노드로 이동 (기존 동작).
- 템플릿 이름이면 → 템플릿을 **현재 pipeline의 stages[]에 insert**. 호스트 노드의 해당 transition이 템플릿의 entry 노드를 가리키도록 rewire.
- `count: N`은 `next`가 템플릿일 때만 유효. N개 복제해서 병렬 insert + synthetic fan-in barrier.
- `count` 생략 시 1회 insert.

제거되는 것: `retry`, `next_dynamic`, `kind: "dynamic-fanout"`, `fan_in: "dynamic"`, `next: string[]` (multi-target 직접 표기 — barrier synthesis를 통해서만 생성).

### Template

재사용 가능한 부분그래프. 파일: `__art__/templates/<name>.json`.

```jsonc
{
  "entry": "<stage-name>",   // optional, 기본값 stages[0].name
  "stages": [ ... ]          // PipelineStage[]
}
```

- 템플릿은 **외부 노드를 참조할 수 있음** (forward reference만). DAG 보존은 stitch-time validator가 검사.
- 템플릿의 stage 중 `next: null`인 것은 그냥 **파이프라인 종료**를 의미 (옵션 1). 호스트의 다음 노드로 auto-rewire 하지 않음.
- 템플릿은 다른 템플릿을 `next`로 참조 가능. 그 템플릿이 runtime에 stitch될 뿐.

### Option 1 semantics (template tail)

**템플릿은 호스트 노드 이후의 흐름을 전부 책임진다.** 템플릿 외부의 "fallback next" 같은 개념 없음. 템플릿 내부 모든 경로는 자기가 `next: null` (종료) 또는 다른 스테이지/템플릿을 명시해야 함.

## 삽입 노드 이름 (user-visible)

```
{origin}__{templateName}{n}__{templateStage}
```

예:
- selection으로 한 번 insert: `review__revert-tpl0__checkout`, `review__revert-tpl0__rebuild`
- parallel_run count=3: `review__review-tpl0__build`, `review__review-tpl1__build`, `review__review-tpl2__build`
- parallel_run의 barrier: `review__review-tpl__barrier`

`n`은 host 노드 기준 insert 카운터. 같은 host가 같은 템플릿을 여러 번 쓸 일은 드물지만 (DAG에서 host는 한 번만 실행), parallel_run의 각 replica를 구분할 때 사용.

## State 파일 포맷 (v2, breaking)

```typescript
interface PipelineStateV2 {
  version: 2;
  currentStage: string;
  completedStages: string[];
  activations: Record<string, number>;
  completions: Record<string, number>;
  pendingInsertPayloads: Record<string, string>;  // rename from pendingFanoutPayloads
  insertedStages: PipelineStage[];                 // NEW — stitch 결과 영속화
}
```

- Resume 시 base `PIPELINE.json` load 후 `insertedStages`를 merge 하여 그래프 복원.
- v1 state 파일은 인식 시 에러, resume 불가.

## 삭제 항목

| 항목 | 위치 |
|------|------|
| `StageKind` 중 `'dynamic-fanout'` | `src/pipeline-runner.ts:63` |
| `runFanoutStage` 및 호출부 | `src/pipeline-runner.ts:1791-1793`, `1962-2128` |
| `pickFanoutTransition` | `src/pipeline-runner.ts:2135-2146` |
| fanout 관련 validator (`validateFanoutStage`, `FANOUT_FORBIDDEN_FIELDS`) | `src/pipeline-runner.ts:2413-2526` |
| `retry: true` 분기 | `src/pipeline-runner.ts:1549-1591` |
| `next_dynamic` 분기 | `src/pipeline-runner.ts:1595-1623` |
| `next_dynamic` / `retry` 관련 validator | `src/pipeline-runner.ts:2688-2721` |
| `fan_in: "dynamic"` validator | `src/pipeline-runner.ts:2675-2686` |
| `deriveChildScopeId`, `assertFanoutDepthAllowed`, `readFanoutDepth`, `MAX_FANOUT_RECURSION_DEPTH` | `src/fanout.ts` |
| `ART_FANOUT_DEPTH` env 사용처 전부 | |
| `src/fanout.test.ts` | 전체 |
| Docs / SKILL의 fanout, retry, next_dynamic 섹션 | `docs/PIPELINE-REFERENCE.md`, `.claude/skills/generate-pipeline/SKILL.md` |

## 유지 / 재활용

| 항목 | 비고 |
|------|------|
| `fan_in: "all"` + activations/completions 트래킹 | synthetic barrier의 동작 원리 |
| State 영속화 메커니즘 (`PIPELINE_STATE.<scopeId>.json`) | 포맷만 v2로 확장 |
| Marker parsing (`parseStageMarkers`) | 그대로 |
| 묵시적 retry (parse miss → hint 넣고 무한 재시도) | 그대로. user-facing flag 없음 |
| Container respawn cap (`MAX_CONTAINER_RESPAWNS=3`) | 그대로 |
| `parseFanoutPayload`, `applyFanoutSubstitutions`, `withConcurrency` | `src/stitch.ts`로 이전 |
| `pendingFanoutPayloads` map | `pendingInsertPayloads`로 rename, 의미 동일 |
| Scope-based 세션/로그 격리 | 단일 scope 유지. stitch된 stage도 unique name이라 자연 격리 |

## 신규 구축

### 1. Template loader & validator

파일: `src/templates/pipeline-template.ts`

- `loadPipelineTemplate(name: string): PipelineTemplate`
- Path 격납 검사, JSON 파싱, 스키마 검증.
- 검증 항목:
  - `entry` 스테이지가 `stages`에 존재 (또는 `stages[0]`).
  - 템플릿 내부 transition target이 (a) 같은 템플릿 내 스테이지, (b) 다른 템플릿, (c) `null` 중 하나.
  - 외부 노드 이름 참조는 허용하되 경고 수준 기록 (base pipeline과 stitch 시점에 최종 검증).
  - 템플릿 자체의 부분그래프 DAG 검증.

### 2. Stitch core (`src/stitch.ts`)

순수 함수 위주, graph in/out:

```typescript
function stitchSingle(params: {
  config: PipelineConfig;
  originStage: string;
  originTransitionIdx: number;
  template: PipelineTemplate;
  substitutions: Record<string, unknown>;
  insertId: string;
}): { updatedStages: PipelineStage[]; entryName: string }

function stitchParallel(params: {
  config: PipelineConfig;
  originStage: string;
  originTransitionIdx: number;
  template: PipelineTemplate;
  count: number;
  substitutionsPerIndex: Array<Record<string, unknown>>;
  insertId: string;
}): { updatedStages: PipelineStage[]; entryNames: string[]; barrierName: string }
```

책임:
- 이름 rewrite (규칙은 위 "삽입 노드 이름" 참조).
- 템플릿 내부 transition `next` rewrite (같은 insertion의 새 이름으로).
- 호스트 transition의 `next`를 rewrite된 entry로 rewire.
- Parallel: barrier 합성 (command kind, `fan_in: "all"`, 원본 호스트 transition의 의도상 "다음"은 옵션 1에 의해 없음 — barrier도 `next: null`. 호스트가 원래 가리키던 '템플릿 이름'이 곧 barrier의 의미상 끝).
- Substitution 적용: `{{insertId}}`, `{{index}}` (parallel), 사용자 payload 키.

### 3. Stitch-time validator

매 insert 호출 시:
- 삽입될 스테이지 이름이 기존 그래프와 충돌 없음.
- 삽입 후 전체 그래프가 여전히 DAG (topological sort 가능).
- 템플릿이 참조하는 외부 노드/템플릿이 모두 존재.

### 4. `handleStageResult` 경로 교체

기존 `retry`, `next_dynamic` 분기 제거. 단일 transition 분기에서:
- `next`가 기존 스테이지 이름이면 현재처럼 이동.
- `next`가 등록된 템플릿 이름이면:
  - `count` 없음 → `stitchSingle` 호출, entry로 이동.
  - `count: N` → `stitchParallel` 호출, N개 entry를 multi-activation으로 시작.
- 두 경우 모두 `insertedStages`를 state에 반영.

Payload forwarding: 기존 `pendingFanoutPayloads` 로직을 `pendingInsertPayloads`로 일반화. template insert의 `fromPayload` 케이스에서 predecessor가 흘린 payload를 substitution 소스로 사용.

### 5. Loader-time validator 업데이트

- `dynamic-fanout`, `retry`, `next_dynamic`, `fan_in: "dynamic"` 체크 전부 제거.
- Base PIPELINE.json DAG 검증 추가 (현재는 transition target 존재만 검사, 사이클 검사 없음).
- Transition `next`가 (a) 스테이지 이름 (b) 템플릿 이름 (c) `null` 중 하나로 해석 가능한지 검증.
- `count`는 `next`가 템플릿일 때만 허용.

### 6. `examples/autoresearch` 재설계

현재의 `git-keep → build` 사이클 제거. 새 구조 예시:

- Base pipeline: `git-init → build → git-commit → test → review`
- `review` transitions:
  - `[STAGE_DONE]` → `null` (종료)
  - `[STAGE_KEEP]` → `"next-experiment"` (템플릿: 새 build→commit→test→review 체인)
  - `[STAGE_RESET]` → `"revert-and-continue"` (템플릿: revert + 새 실험 체인)

각 템플릿 안에 또 다른 review가 있고, 그 review가 다시 같은 결정을 내림. 그래프가 필요한 만큼 아래로 자람.

### 7. Docs / SKILL

- `docs/PIPELINE-REFERENCE.md`: fanout/retry/next_dynamic 섹션 전부 삭제. stitch + template + 통합 transition schema로 재작성.
- `.claude/skills/generate-pipeline/SKILL.md`: 스키마 참조와 예제 업데이트.

## 구현 순서

1. `src/templates/pipeline-template.ts` (loader + 템플릿 자체 validator) + 단위 테스트.
2. `src/stitch.ts` (stitchSingle, stitchParallel, substitution, 이름 rewrite) + 단위 테스트 (순수 함수).
3. Stitch-time validator + 테스트.
4. State v2 포맷 정의, load/save 업데이트.
5. `handleStageResult`에 stitch 분기 추가 (legacy 경로는 아직 병존).
6. Legacy 삭제: `dynamic-fanout`, `retry`, `next_dynamic`, `fan_in: "dynamic"`, 관련 validator, `fanout.ts`의 불필요 helper, `fanout.test.ts`.
7. `examples/autoresearch` 재설계.
8. Docs / SKILL 업데이트.
9. `pipeline-runner.test.ts`의 legacy 테스트 제거 및 stitch 테스트 추가.

## 테스트 전략

- **Unit (`src/stitch.ts`)**: 이름 rewrite, transition rewire, substitution, barrier 합성이 그래프 in/out으로 깔끔하게 검증됨. mock 불필요.
- **Template validator**: 불변식 하나씩 케이스로.
- **Integration (`pipeline-runner.test.ts`)**: 실제 파이프라인을 stitch하면서 state 영속화/resume 동작 확인.
- **End-to-end (`examples/autoresearch`)**: 재설계된 파이프라인이 실제로 체인 확장되며 실행되는지.

## 관측성 (깊이 제한 대체)

깊이 제한 없음 — 대신 stitch 로그를 남김:

- 매 insert 시 `[STITCH] origin=<name> template=<name> insertId=<id> count=<N>` 정보를 pipeline log에 기록.
- State의 `insertedStages.length`가 비정상적으로 커지면 운영자가 조기 발견 가능.

## 이후에 결정할 것 (v1 이후)

- Payload-driven count (`fromPayload: true`): v1에서는 `count: N` 고정만 지원. payload 기반 N은 후속.
- 다중 템플릿 parallel mix (`[{template: "a"}, {template: "b"}]`): v1은 단일 템플릿 N복제만.
- Template의 외부 노드 forward reference: 허용하되, 실제 필요성이 확인되기 전까진 권장하지 않음.
- Inserted stage를 사용자 UI에서 접어서 보여주는 것 (그룹핑 표시): 이름 prefix 기반으로 후속 추가 가능.
