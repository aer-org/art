export const run = {
    name: 'run',
    type: 'command',
    description: 'Generic shell command runner. Set command and image per use case.',
    prompt: '',
    command: 'echo "No command configured" && echo \'[STAGE_COMPLETE]\'',
    mounts: {
        project: 'ro',
    },
    transitions: [{ marker: '[STAGE_COMPLETE]', next: null }],
};
//# sourceMappingURL=run.js.map