export const gitReset = {
    name: 'git-reset',
    type: 'command',
    description: 'Hard-reset the last commit (revert failed experiment).',
    prompt: '',
    command: 'git config --global --add safe.directory /workspace/project && cd /workspace/project && git reset --hard HEAD~1 && echo \'[STAGE_COMPLETE]\'',
    image: 'alpine/git',
    mounts: {
        project: 'rw',
    },
    transitions: [
        { marker: '[STAGE_COMPLETE]', next: null },
    ],
};
//# sourceMappingURL=git-reset.js.map