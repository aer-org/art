export const deploy = {
    name: 'deploy',
    type: 'agent',
    description: 'Deployment stage. Reads source, writes build artifacts.',
    prompt: 'Build and deploy the project from /workspace/extra/src/. Write outputs to /workspace/extra/build/.',
    mounts: { project: 'ro', plan: 'ro', src: 'ro', build: 'rw', tests: null },
    transitions: [
        { marker: '[STAGE_COMPLETE]', next: null, prompt: 'Deploy complete' },
        { marker: '[STAGE_ERROR]', next: null, prompt: 'Environment/tool/config error' },
    ],
};
//# sourceMappingURL=deploy.js.map