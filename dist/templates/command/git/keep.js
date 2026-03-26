export const gitKeep = {
    name: 'git-keep',
    type: 'command',
    description: 'Passthrough — keep current commit and move to next stage.',
    prompt: '',
    command: "echo 'Keeping commit' && echo '[STAGE_COMPLETE]'",
    image: 'alpine/git',
    mounts: {},
    transitions: [
        { marker: '[STAGE_COMPLETE]', next: null },
    ],
};
//# sourceMappingURL=keep.js.map