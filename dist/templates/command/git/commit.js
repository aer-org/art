const GIT_CONFIG = "git config --global --add safe.directory /workspace/project && git config --global user.email 'art-agent@local' && git config --global user.name 'AerArt Agent'";
export const gitCommit = {
    name: 'git-commit',
    type: 'command',
    description: 'Stage and commit all changes with a message from commit-msg.txt.',
    prompt: '',
    command: `${GIT_CONFIG} && cd /workspace/project && git add -A && git commit --allow-empty -m "$(cat /workspace/msg/commit-msg.txt 2>/dev/null || echo 'iteration')" && echo '[STAGE_COMPLETE]'`,
    image: 'alpine/git',
    mounts: {
        project: 'rw',
        msg: 'ro',
    },
    transitions: [
        { marker: '[STAGE_COMPLETE]', next: null },
    ],
};
//# sourceMappingURL=commit.js.map