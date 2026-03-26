export const deploy = {
    name: 'deploy',
    type: 'agent',
    description: 'Deployment stage. Reads source, writes build artifacts.',
    prompt: 'Build and deploy the project from /workspace/extra/src/. Write outputs to /workspace/extra/build/.',
    mounts: { project: 'ro', plan: 'ro', src: 'ro', build: 'rw', tests: null },
    transitions: [
        { marker: '[STAGE_COMPLETE]', next: null, prompt: '배포 완료' },
        { marker: '[STAGE_ERROR]', next: null, prompt: '환경/도구/설정 에러' },
    ],
};
//# sourceMappingURL=deploy.js.map