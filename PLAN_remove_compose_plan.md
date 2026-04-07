# Plan: Remove `art compose` and Plan Agent

## Phase 1: Remove `art compose` CLI command

### Delete
- `src/cli/compose.ts` — 전체 삭제 (1,471줄)
- `team-editor/` — 웹 UI 프론트엔드 통째로 삭제

### Modify
- `src/cli/index.ts`
  - L44-50: `case 'compose'` 제거
  - L19-26: `art init` → compose 리다이렉트 제거
- `src/cli/run.ts` L85: "Run 'art compose .' first" → "Run 'art init .' first"
- `src/cli/update.ts` L18: "Run 'art compose' first" → "Run 'art init' first"
- `package.json`: compose 관련 dependency 있으면 제거

## Phase 2: Remove Plan Agent template

### Delete
- `src/templates/agent/plan.ts` — plan agent 템플릿 삭제

### Modify
- `src/templates/index.ts`
  - L4: `import { plan }` 제거
  - L24: `export { plan }` 제거
  - L40: STAGE_TEMPLATES['plan'] 등록 제거
- `src/cli/init.ts` L54-58: `__art__/plan/PLAN.md` scaffolding 제거
- `src/templates/agent/build.ts`: `plan: 'ro'` mount 제거
- `src/templates/agent/deploy.ts`: `plan: 'ro'` mount 제거
- `src/templates/agent/test.ts`: `plan: null` 제거
- `src/templates/agent/review.ts`: `plan: null` 제거
- `src/templates/agent/history.ts`: `plan: null` 제거

## Phase 3: Cleanup

- `src/cli/onboard.ts` L210: plan mount 참조 확인/제거
- `src/stage-templates.ts`: plan re-export 제거
- run-manifest, run-engine 등에서 compose 참조 grep → 제거
- `npm run build` + `npm test` 통과 확인
- dist/ 빌드 결과물 커밋

## 유지하는 것

- `art run` — 핵심 파이프라인 실행 (변경 없음)
- `art init` — scaffolding (compose 없이 독립 동작하도록)
- PIPELINE.json의 `plan` mount key — 유저가 직접 정의하는 것이므로 runner 쪽은 그대로
- `generate-pipeline` skill의 plan mount 예시 — 유효한 사용 패턴이므로 유지
