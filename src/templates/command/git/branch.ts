import type { StageTemplate } from '../../base.js';

const GIT_CONFIG =
  "git config --global --add safe.directory /workspace/project && git config --global user.email 'art-agent@local' && git config --global user.name 'AerArt Agent'";

export const gitBranch: StageTemplate = {
  name: 'git-branch',
  type: 'command',
  description: 'Create a new timestamped branch and an empty baseline commit.',
  prompt: '',
  command: `${GIT_CONFIG} && cd /workspace/project && TAG=$(date +%b%d-%H%M | tr '[:upper:]' '[:lower:]') && git checkout -b run/$TAG && git commit --allow-empty -m 'baseline' && echo '[STAGE_COMPLETE]'`,
  image: 'alpine/git',
  mounts: {
    project: 'rw',
  },
  transitions: [{ marker: '[STAGE_COMPLETE]', next: null }],
};
