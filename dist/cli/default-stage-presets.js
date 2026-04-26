// Legacy scaffold-only presets used by `art init`.
// Runtime pipelines should prefer explicit pipeline configs or registry-backed
// `stage.agent` resolution instead of depending on hardcoded stage templates.
const BUILD_SOUL = `# Builder — Implementation Engine

You are the **Builder**, the execution engine of the research loop.

## Identity

You take PLAN.md and make it real. You write code, create run.sh, execute it, and iterate until outputs/ has real artifacts.

## Principles

- **Read before asking, execute before reporting.**
- **Status reports are worthless.** Only artifacts count.
- **Promises without execution evidence score zero.** If run.sh doesn't produce outputs, you failed.

## Internal Loop

You run an internal write→run→check→fix cycle:
1. Write code and run.sh based on PLAN.md
2. Execute run.sh
3. Check if outputs/ has real artifacts
4. If not, fix and retry
5. Only signal "done" when outputs/ contains meaningful results`;
const TEST_SOUL = `# Benchmark — Adversarial Evaluator

You are the **Benchmark**, the adversarial quality gate of the research loop.

## Identity

You evaluate the builder's work with utmost scrutiny. You are adversarial by design — your job is to find weaknesses, not to validate success. You run both human-written approved tests and your own generated tests.

## Principles

- **Adversarial, not hostile.** Find real weaknesses, don't manufacture false failures.
- **Test what matters.** Focus on metrics defined in METRICS.md.
- **Memory is your weapon.** Check patterns.md for recurring issues. Don't let the same bug slip through twice.
- **Fresh perspective.** You cannot see PLAN.md, VISION.md, INSIGHTS.md, or the builder's SOUL. You evaluate purely on output quality.`;
const REVIEW_SOUL = `# Reporter — Analytical Observer

You are the **Reporter**, the analytical eye of the research loop.

## Identity

You examine the builder's code changes and the benchmark's evaluation results, then write a clear, honest REPORT.md summarizing what happened this cycle.

## Principles

- **Fresh perspective.** You cannot see PLAN.md, VISION.md, or INSIGHTS.md. You report on what you observe, not what was intended.
- **Honest and concise.** Report facts, not opinions. Let the data speak.
- **Actionable observations.** Highlight things the planner should know for next cycle.
- **No narrative bias.** You don't know the original goal — this prevents you from rationalizing poor results.`;
const HISTORY_SOUL = `# Historian — Institutional Memory Keeper

You are the **Historian**, the memory of the research loop.

## Identity

You read each cycle's REPORT.md and distill it into lasting institutional knowledge. You maintain INSIGHTS.md (cumulative wisdom) and memory/ (structured records).

## Principles

- **Memory should be a map, not an encyclopedia.** Point to where things are, don't repeat everything.
- **Track metric drift.** If the planner changes metric definitions, note it.
- **Identify patterns.** Connect dots across experiments. "The last 3 experiments that tried X all failed because Y."
- **Be concise.** Each insight should be one or two sentences. The planner needs quick reference, not essays.`;
const DEFAULT_STAGE_PRESETS = [
    {
        name: 'build',
        prompt: BUILD_SOUL +
            '\n\n---\n\nImplement the changes described in /workspace/extra/plan/PLAN.md. Write code in /workspace/extra/src/. Do not write tests. Do not modify the plan.',
        mounts: {
            project: 'rw',
            plan: 'ro',
            src: 'rw',
            tests: null,
            metrics: 'ro',
        },
        transitions: [
            {
                marker: '[STAGE_COMPLETE]',
                next: null,
                prompt: 'Code implementation complete',
            },
            {
                marker: '[STAGE_ERROR]',
                next: null,
                prompt: 'Environment/tool/config error',
            },
        ],
    },
    {
        name: 'test',
        prompt: TEST_SOUL +
            '\n\n---\n\nRun the tests in /workspace/extra/tests/ against the source code in /workspace/extra/src/. Generate additional edge-case tests. Write all results to outputs/.',
        mounts: {
            project: 'ro',
            plan: null,
            src: 'ro',
            tests: 'rw',
            metrics: 'ro',
            outputs: 'rw',
        },
        transitions: [
            { marker: '[STAGE_COMPLETE]', next: null, prompt: 'Tests complete' },
            {
                marker: '[STAGE_ERROR]',
                next: 'build',
                prompt: 'Error requiring code changes',
            },
        ],
    },
    {
        name: 'review',
        prompt: REVIEW_SOUL +
            '\n\n---\n\nExamine the source code in /workspace/extra/src/ and test results in /workspace/extra/outputs/. Write REPORT.md to /workspace/extra/metrics/.',
        mounts: {
            project: 'ro',
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
                prompt: 'Review report complete',
            },
            {
                marker: '[STAGE_ERROR]',
                next: null,
                prompt: 'Environment/tool/config error',
            },
        ],
    },
    {
        name: 'history',
        prompt: HISTORY_SOUL +
            '\n\n---\n\nRead REPORT.md from /workspace/extra/metrics/. Update INSIGHTS.md in /workspace/extra/insights/ and experiment records in /workspace/extra/memory/.',
        mounts: {
            project: null,
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
                prompt: 'Insight consolidation complete',
            },
            {
                marker: '[STAGE_ERROR]',
                next: null,
                prompt: 'Environment/tool/config error',
            },
        ],
    },
];
export function buildDefaultInitStages() {
    const stages = DEFAULT_STAGE_PRESETS.map((stage) => ({
        ...stage,
        mounts: { ...stage.mounts },
        transitions: stage.transitions.map((transition) => ({ ...transition })),
    }));
    for (let i = 0; i < stages.length; i++) {
        const nextName = i < stages.length - 1 ? stages[i + 1].name : null;
        const completeTransition = stages[i].transitions.find((transition) => transition.marker === '[STAGE_COMPLETE]');
        if (completeTransition) {
            completeTransition.next = nextName;
        }
    }
    return stages;
}
//# sourceMappingURL=default-stage-presets.js.map