import type { StageTemplate } from '../../base.js';

const GIT_CONFIG =
  "git config --global --add safe.directory /workspace/project && git config --global user.email 'art-agent@local' && git config --global user.name 'AerArt Agent'";

export const gitReset: StageTemplate = {
  name: 'git-reset',
  type: 'command',
  description: 'Hard-reset the last commit (revert failed experiment).',
  prompt: '',
  command: `${GIT_CONFIG} && cd /workspace/project && git reset --hard HEAD~1 && echo '[STAGE_COMPLETE]'`,
  image: 'alpine/git',
  mounts: {
    project: 'rw',
  },
  transitions: [{ marker: '[STAGE_COMPLETE]', next: null }],
};
