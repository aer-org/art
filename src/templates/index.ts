export type { StageTemplate } from './base.js';

// Agent templates
import { plan } from './agent/plan.js';
import { build } from './agent/build.js';
import { test } from './agent/test.js';
import { review } from './agent/review.js';
import { history } from './agent/history.js';
import { deploy } from './agent/deploy.js';
import { git } from './agent/git.js';

// Command templates — git
import { gitInit } from './command/git/init.js';
import { gitBranch } from './command/git/branch.js';
import { gitCommit } from './command/git/commit.js';
import { gitReset } from './command/git/reset.js';
import { gitKeep } from './command/git/keep.js';
import { gitPush } from './command/git/push.js';
import { gitPr } from './command/git/pr.js';

// Command templates — general
import { run } from './command/run.js';

export { plan, build, test, review, history, deploy, git };
export { gitInit, gitBranch, gitCommit, gitReset, gitKeep, gitPush, gitPr, run };

import type { StageTemplate } from './base.js';

export const STAGE_TEMPLATES: Record<string, StageTemplate> = {
  // Agent
  plan,
  build,
  test,
  review,
  history,
  deploy,
  git,
  // Command — git
  'git-init': gitInit,
  'git-branch': gitBranch,
  'git-commit': gitCommit,
  'git-reset': gitReset,
  'git-keep': gitKeep,
  'git-push': gitPush,
  'git-pr': gitPr,
  // Command — general
  run,
};

export function getTemplate(name: string): StageTemplate | undefined {
  return STAGE_TEMPLATES[name];
}

export function listTemplates(): StageTemplate[] {
  return Object.values(STAGE_TEMPLATES);
}
