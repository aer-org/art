import type { PipelineStage } from './types';

export interface TemplateEntry {
  name: string;
  type: 'agent' | 'command';
  category: string;
  description: string;
  stage: PipelineStage;
}

const COMPLETE = { marker: 'STAGE_COMPLETE', next: null as string | null, prompt: '작업이 성공적으로 완료됨' };
const ERROR = { marker: 'STAGE_ERROR', retry: true, prompt: '환경/도구/설정 에러' };

const agent = (
  name: string,
  description: string,
  mounts: PipelineStage['mounts'],
  transitions: PipelineStage['transitions'],
): TemplateEntry => ({
  name,
  type: 'agent',
  category: 'agent',
  description,
  stage: { name, prompt: '', mounts, transitions },
});

export const AGENT_TEMPLATES: TemplateEntry[] = [
  agent('plan', 'Read vision & insights, write PLAN.md', { project: 'ro', plan: 'rw', metrics: 'ro', insights: 'ro', memory: 'ro' }, [{ ...COMPLETE, next: 'build' }, ERROR]),
  agent('build', 'Implement code changes from PLAN.md', { project: 'rw', plan: 'ro', src: 'rw', metrics: 'ro' }, [{ ...COMPLETE, next: 'test' }, ERROR]),
  agent('test', 'Run tests against source code', { project: 'ro', src: 'ro', tests: 'rw', metrics: 'ro', outputs: 'rw' }, [COMPLETE, { marker: 'STAGE_ERROR', next: 'build', prompt: '코드 수정이 필요한 에러' }]),
  agent('review', 'Examine results, write REPORT.md', { project: 'ro', src: 'ro', tests: 'ro', metrics: 'rw', outputs: 'ro' }, [COMPLETE, ERROR]),
  agent('history', 'Distill report into insights & memory', { metrics: 'ro', insights: 'rw', memory: 'rw' }, [COMPLETE, ERROR]),
  agent('deploy', 'Build and deploy artifacts', { project: 'ro', plan: 'ro', src: 'ro', build: 'rw' }, [COMPLETE, ERROR]),
  agent('git', 'Git operations (commit, branch, push, PR). Source ro, .git rw', { project: 'ro', 'project:.git': 'rw' }, [COMPLETE, ERROR]),
];

const GIT_CFG = "git config --global --add safe.directory /workspace/project && git config --global user.email 'art-agent@local' && git config --global user.name 'AerArt Agent'";

const cmd = (
  name: string,
  category: string,
  description: string,
  command: string,
  mounts: PipelineStage['mounts'],
  transitions: PipelineStage['transitions'],
  extra?: Partial<PipelineStage>,
): TemplateEntry => ({
  name,
  type: 'command',
  category,
  description,
  stage: { name, prompt: '', command, image: 'alpine/git', mounts, transitions, ...extra },
});

export const COMMAND_TEMPLATES: TemplateEntry[] = [
  cmd('git-init', 'git', 'Initialize git repo (skip if exists)',
    `${GIT_CFG} && cd /workspace/project && if [ -d .git ]; then echo 'Already initialized'; else git init; fi && echo '[STAGE_COMPLETE]'`,
    { project: 'rw' }, [{ marker: 'STAGE_COMPLETE', next: null }]),
  cmd('git-branch', 'git', 'Create new timestamped branch',
    `${GIT_CFG} && cd /workspace/project && TAG=$(date +%b%d-%H%M | tr '[:upper:]' '[:lower:]') && git checkout -b run/$TAG && git commit --allow-empty -m 'baseline' && echo '[STAGE_COMPLETE]'`,
    { project: 'rw' }, [{ marker: 'STAGE_COMPLETE', next: null }]),
  cmd('git-commit', 'git', 'Commit all changes',
    `${GIT_CFG} && cd /workspace/project && git add -A && git commit --allow-empty -m "$(cat /workspace/msg/commit-msg.txt 2>/dev/null || echo 'iteration')" && echo '[STAGE_COMPLETE]'`,
    { project: 'rw', msg: 'ro' }, [{ marker: 'STAGE_COMPLETE', next: null }]),
  cmd('git-reset', 'git', 'Revert last commit',
    `${GIT_CFG} && cd /workspace/project && git reset --hard HEAD~1 && echo '[STAGE_COMPLETE]'`,
    { project: 'rw' }, [{ marker: 'STAGE_COMPLETE', next: null }]),
  cmd('git-keep', 'git', 'Passthrough (noop)',
    "echo 'Keeping commit' && echo '[STAGE_COMPLETE]'",
    {}, [{ marker: 'STAGE_COMPLETE', next: null }]),
  cmd('git-push', 'git', 'Push to remote origin',
    `${GIT_CFG} && cd /workspace/project && git push -u origin HEAD && echo '[STAGE_COMPLETE]'`,
    { project: 'rw' }, [{ marker: 'STAGE_COMPLETE', next: null }, { marker: 'STAGE_ERROR', next: null, prompt: 'Push failed' }]),
  cmd('git-pr', 'git', 'Create GitHub PR',
    'cd /workspace/project && TITLE=$(git log -1 --pretty=%s) && BODY=$(git log -1 --pretty=%b) && gh pr create --title "$TITLE" --body "${BODY:-Auto-generated}" && echo \'[STAGE_COMPLETE]\'',
    { project: 'ro' }, [{ marker: 'STAGE_COMPLETE', next: null }, { marker: 'STAGE_ERROR', next: null, prompt: 'PR creation failed' }]),
  cmd('run', 'general', 'Generic shell command',
    'echo "[STAGE_COMPLETE]"',
    { project: 'ro' }, [{ marker: 'STAGE_COMPLETE', next: null }],
    { image: 'node:22-slim' }),
];

export const ALL_TEMPLATES: TemplateEntry[] = [...AGENT_TEMPLATES, ...COMMAND_TEMPLATES];
