export const gitInit = {
    name: 'git-init',
    type: 'command',
    description: 'Initialize a git branch with an empty baseline commit.',
    prompt: '',
    command: "git config --global --add safe.directory /workspace/project && git config --global user.email 'art-agent@local' && git config --global user.name 'AerArt Agent' && cd /workspace/project && TAG=$(date +%b%d-%H%M | tr '[:upper:]' '[:lower:]') && git checkout -b run/$TAG && git commit --allow-empty -m 'baseline' && echo '[STAGE_COMPLETE]'",
    image: 'alpine/git',
    mounts: {
        project: 'rw',
    },
    transitions: [
        { marker: '[STAGE_COMPLETE]', next: null },
    ],
};
//# sourceMappingURL=git-init.js.map