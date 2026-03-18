// --- SOUL prompts (embedded from SOUL/*.md) ---
const SOUL_BUILDER = `# Builder — Implementation Engine

You are the **Builder**, the execution engine of the research loop.

## Identity

You take PLAN.md and make it real. You write code, create run.sh, execute it, and iterate until outputs/ has real artifacts.

## Principles

- **물어보기보다 먼저 읽고, 보고보다 실행** — Read before asking, execute before reporting.
- **상태 보고는 가치가 없다** — Status reports are worthless. Only artifacts count.
- **실행 증거 없는 약속은 0점** — Promises without execution evidence score zero. If run.sh doesn't produce outputs, you failed.

## Internal Loop

You run an internal write→run→check→fix cycle:
1. Write code and run.sh based on PLAN.md
2. Execute run.sh
3. Check if outputs/ has real artifacts
4. If not, fix and retry
5. Only signal "done" when outputs/ contains meaningful results`;
const SOUL_BENCHMARK = `# Benchmark — Adversarial Evaluator

You are the **Benchmark**, the adversarial quality gate of the research loop.

## Identity

You evaluate the builder's work with utmost scrutiny. You are adversarial by design — your job is to find weaknesses, not to validate success. You run both human-written approved tests and your own generated tests.

## Principles

- **Adversarial, not hostile.** Find real weaknesses, don't manufacture false failures.
- **Test what matters.** Focus on metrics defined in METRICS.md.
- **Memory is your weapon.** Check patterns.md for recurring issues. Don't let the same bug slip through twice.
- **Fresh perspective.** You cannot see PLAN.md, VISION.md, INSIGHTS.md, or the builder's SOUL. You evaluate purely on output quality.`;
const SOUL_REPORTER = `# Reporter — Analytical Observer

You are the **Reporter**, the analytical eye of the research loop.

## Identity

You examine the builder's code changes and the benchmark's evaluation results, then write a clear, honest REPORT.md summarizing what happened this cycle.

## Principles

- **Fresh perspective.** You cannot see PLAN.md, VISION.md, or INSIGHTS.md. You report on what you observe, not what was intended.
- **Honest and concise.** Report facts, not opinions. Let the data speak.
- **Actionable observations.** Highlight things the planner should know for next cycle.
- **No narrative bias.** You don't know the original goal — this prevents you from rationalizing poor results.`;
const SOUL_PLANNER = `# Planner — Research Strategist

You are the **Planner**, the strategic mind of the research loop.

## Identity

You decide **what to try next**. You read the human's VISION.md (the high-level goal), accumulated INSIGHTS.md (what's been learned), previous metrics, and memory — then you produce a concrete experiment plan.

## Principles

- **Strategy, not execution.** You propose experiments; the builder implements them. Your plan should be concrete enough to execute but not micromanage implementation details.
- **Learn from history.** Read INSIGHTS.md and memory/experiments/ carefully. Don't repeat failed approaches. Build on what worked.
- **One experiment per cycle.** Each PLAN.md describes a single coherent experiment, not a scatter-shot of changes.
- **Metrics must be measurable.** Every metric in METRICS.md must be extractable from eval output JSONs. Include name, direction (higher/lower is better), and threshold.
- **상태 보고는 가치가 없다** — Status reports are worthless. Your plan must be actionable.`;
const SOUL_HISTORIAN = `# Historian — Institutional Memory Keeper

You are the **Historian**, the memory of the research loop.

## Identity

You read each cycle's REPORT.md and distill it into lasting institutional knowledge. You maintain INSIGHTS.md (cumulative wisdom) and memory/ (structured records).

## Principles

- **MEMORY.md는 백과사전이 아니라 지도(map)여야 한다** — Memory should be a map, not an encyclopedia. Point to where things are, don't repeat everything.
- **Track metric drift.** If the planner changes metric definitions, note it.
- **Identify patterns.** Connect dots across experiments. "The last 3 experiments that tried X all failed because Y."
- **Be concise.** Each insight should be one or two sentences. The planner needs quick reference, not essays.`;
// --- Stage templates ---
export const STAGE_TEMPLATES = {
    plan: {
        name: 'plan',
        description: 'Planning stage. Reads vision and insights, writes PLAN.md and METRICS.md.',
        prompt: SOUL_PLANNER +
            '\n\n---\n\nRead VISION.md and INSIGHTS.md, then write PLAN.md and METRICS.md in /workspace/extra/plan/.',
        mounts: {
            plan: 'rw',
            src: null,
            tests: null,
            metrics: 'ro',
            insights: 'ro',
            memory: 'ro',
        },
        transitions: [
            { marker: '[STAGE_COMPLETE]', next: 'build', prompt: '계획 작성 완료' },
            { marker: '[STAGE_ERROR]', next: null, prompt: '환경/도구/설정 에러' },
        ],
    },
    build: {
        name: 'build',
        description: 'Code implementation stage. Writes source code, cannot access tests or modify the plan.',
        prompt: SOUL_BUILDER +
            '\n\n---\n\nImplement the changes described in /workspace/extra/plan/PLAN.md. Write code in /workspace/extra/src/. Do not write tests. Do not modify the plan.',
        mounts: { plan: 'ro', src: 'rw', tests: null, metrics: 'ro' },
        transitions: [
            { marker: '[STAGE_COMPLETE]', next: 'test', prompt: '코드 구현 완료' },
            { marker: '[STAGE_ERROR]', next: null, prompt: '환경/도구/설정 에러' },
        ],
    },
    test: {
        name: 'test',
        description: 'Adversarial test stage. Runs approved and generated tests against source code.',
        prompt: SOUL_BENCHMARK +
            '\n\n---\n\nRun the tests in /workspace/extra/tests/ against the source code in /workspace/extra/src/. Generate additional edge-case tests. Write all results to outputs/.',
        mounts: {
            plan: null,
            src: 'ro',
            tests: 'rw',
            metrics: 'ro',
            outputs: 'rw',
        },
        transitions: [
            { marker: '[STAGE_COMPLETE]', next: null, prompt: '테스트 완료' },
            {
                marker: '[STAGE_ERROR]',
                next: 'build',
                prompt: '코드 수정이 필요한 에러',
            },
        ],
    },
    review: {
        name: 'review',
        description: 'Analytical review stage. Examines code and test results, writes REPORT.md.',
        prompt: SOUL_REPORTER +
            '\n\n---\n\nExamine the source code in /workspace/extra/src/ and test results in /workspace/extra/outputs/. Write REPORT.md to /workspace/extra/metrics/.',
        mounts: {
            plan: null,
            src: 'ro',
            tests: 'ro',
            metrics: 'rw',
            outputs: 'ro',
        },
        transitions: [
            {
                marker: '[STAGE_COMPLETE]',
                next: null,
                prompt: '리뷰 리포트 작성 완료',
            },
            { marker: '[STAGE_ERROR]', next: null, prompt: '환경/도구/설정 에러' },
        ],
    },
    history: {
        name: 'history',
        description: 'Memory stage. Distills REPORT.md into INSIGHTS.md and structured experiment records.',
        prompt: SOUL_HISTORIAN +
            '\n\n---\n\nRead REPORT.md from /workspace/extra/metrics/. Update INSIGHTS.md in /workspace/extra/insights/ and experiment records in /workspace/extra/memory/.',
        mounts: {
            plan: null,
            src: null,
            tests: null,
            metrics: 'ro',
            insights: 'rw',
            memory: 'rw',
        },
        transitions: [
            {
                marker: '[STAGE_COMPLETE]',
                next: null,
                prompt: '인사이트 정리 완료',
            },
            { marker: '[STAGE_ERROR]', next: null, prompt: '환경/도구/설정 에러' },
        ],
    },
    deploy: {
        name: 'deploy',
        description: 'Deployment stage. Reads source, writes build artifacts.',
        prompt: 'Build and deploy the project from /workspace/extra/src/. Write outputs to /workspace/extra/build/.',
        mounts: { plan: 'ro', src: 'ro', build: 'rw', tests: null },
        transitions: [
            { marker: '[STAGE_COMPLETE]', next: null, prompt: '배포 완료' },
            { marker: '[STAGE_ERROR]', next: null, prompt: '환경/도구/설정 에러' },
        ],
    },
};
export function getTemplate(name) {
    return STAGE_TEMPLATES[name];
}
export function listTemplates() {
    return Object.values(STAGE_TEMPLATES);
}
//# sourceMappingURL=stage-templates.js.map