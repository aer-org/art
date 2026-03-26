const GIT_CONFIG = "git config --global --add safe.directory /workspace/project && git config --global user.email 'art-agent@local' && git config --global user.name 'AerArt Agent'";
export const gitPush = {
    name: 'git-push',
    type: 'command',
    description: 'Push current branch to remote origin.',
    prompt: '',
    command: `${GIT_CONFIG} && cd /workspace/project && git push -u origin HEAD && echo '[STAGE_COMPLETE]'`,
    image: 'alpine/git',
    mounts: {
        project: 'rw',
    },
    transitions: [
        { marker: '[STAGE_COMPLETE]', next: null },
        { marker: '[STAGE_ERROR]', next: null, prompt: 'Push failed — check remote access' },
    ],
};
//# sourceMappingURL=push.js.map