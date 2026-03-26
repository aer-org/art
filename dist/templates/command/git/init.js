const GIT_CONFIG = "git config --global --add safe.directory /workspace/project && git config --global user.email 'art-agent@local' && git config --global user.name 'AerArt Agent'";
export const gitInit = {
    name: 'git-init',
    type: 'command',
    description: 'Initialize git repo if not already initialized, configure identity.',
    prompt: '',
    command: `${GIT_CONFIG} && cd /workspace/project && if [ -d .git ]; then echo 'Already initialized'; else git init; fi && echo '[STAGE_COMPLETE]'`,
    image: 'alpine/git',
    mounts: {
        project: 'rw',
    },
    transitions: [
        { marker: '[STAGE_COMPLETE]', next: null },
    ],
};
//# sourceMappingURL=init.js.map