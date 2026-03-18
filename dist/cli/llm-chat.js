import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
// ── Codebase Scanner ──
const IGNORE_DIRS = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    '.next',
    '__pycache__',
    '.venv',
    'venv',
    'target',
    '.idea',
    '.vscode',
    'coverage',
    '__art__',
    '.art',
    '.cache',
    '.turbo',
    '.nuxt',
    '.output',
]);
const PRIORITY_FILES = [
    'README.md',
    'package.json',
    'Cargo.toml',
    'pyproject.toml',
    'go.mod',
    'tsconfig.json',
    'Dockerfile',
    'docker-compose.yml',
    'Makefile',
    '.env.example',
    'requirements.txt',
    'setup.py',
    'pom.xml',
    'build.gradle',
    'CMakeLists.txt',
];
const ENTRY_PATTERNS = [
    'src/index.ts',
    'src/main.ts',
    'src/app.ts',
    'src/index.js',
    'src/main.js',
    'src/app.js',
    'main.go',
    'cmd/main.go',
    'app.py',
    'main.py',
    'src/main.rs',
    'src/lib.rs',
    'index.ts',
    'index.js',
    'app/page.tsx',
    'pages/index.tsx',
];
const SOURCE_EXTENSIONS = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.py',
    '.go',
    '.rs',
    '.java',
    '.c',
    '.cpp',
    '.h',
    '.hpp',
    '.rb',
    '.php',
    '.swift',
    '.kt',
    '.scala',
    '.cs',
    '.vue',
    '.svelte',
]);
function walkDir(dir, depth, maxDepth) {
    if (depth > maxDepth)
        return [];
    const results = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.') && entry.name !== '.env.example')
                continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (IGNORE_DIRS.has(entry.name))
                    continue;
                results.push(...walkDir(fullPath, depth + 1, maxDepth));
            }
            else {
                results.push(fullPath);
            }
        }
    }
    catch {
        /* unreadable */
    }
    return results;
}
function buildTree(projectDir, files) {
    const lines = [];
    const rel = files.map((f) => path.relative(projectDir, f)).sort();
    for (const r of rel) {
        const depth = r.split(path.sep).length - 1;
        const indent = '  '.repeat(depth);
        const name = path.basename(r);
        lines.push(`${indent}${name}`);
    }
    return lines.join('\n');
}
export function scanCodebase(projectDir) {
    const BUDGET = 40_000;
    const parts = [];
    let charCount = 0;
    const allFiles = walkDir(projectDir, 0, 4);
    const tree = buildTree(projectDir, allFiles);
    parts.push(`## Directory Tree\n\`\`\`\n${tree}\n\`\`\`\n`);
    charCount += parts[0].length;
    // Priority files
    parts.push('## Key Files\n');
    for (const pf of PRIORITY_FILES) {
        const fullPath = path.join(projectDir, pf);
        if (fs.existsSync(fullPath)) {
            try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const truncated = content.slice(0, 3000);
                const section = `### ${pf}\n\`\`\`\n${truncated}\n\`\`\`\n`;
                if (charCount + section.length < BUDGET) {
                    parts.push(section);
                    charCount += section.length;
                }
            }
            catch {
                /* skip */
            }
        }
    }
    // Entry point files
    parts.push('## Entry Points\n');
    for (const ep of ENTRY_PATTERNS) {
        const fullPath = path.join(projectDir, ep);
        if (fs.existsSync(fullPath)) {
            try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const lines = content.split('\n').slice(0, 50).join('\n');
                const section = `### ${ep}\n\`\`\`\n${lines}\n\`\`\`\n`;
                if (charCount + section.length < BUDGET) {
                    parts.push(section);
                    charCount += section.length;
                }
            }
            catch {
                /* skip */
            }
        }
    }
    // Top source files (first 50 lines each)
    parts.push('## Source Files (top 50 lines)\n');
    const sourceFiles = allFiles
        .filter((f) => SOURCE_EXTENSIONS.has(path.extname(f)))
        .filter((f) => !PRIORITY_FILES.includes(path.relative(projectDir, f)))
        .filter((f) => !ENTRY_PATTERNS.includes(path.relative(projectDir, f)))
        .slice(0, 30);
    for (const sf of sourceFiles) {
        const rel = path.relative(projectDir, sf);
        try {
            const content = fs.readFileSync(sf, 'utf-8');
            const lines = content.split('\n').slice(0, 50).join('\n');
            const section = `### ${rel}\n\`\`\`\n${lines}\n\`\`\`\n`;
            if (charCount + section.length < BUDGET) {
                parts.push(section);
                charCount += section.length;
            }
            else {
                break;
            }
        }
        catch {
            /* skip */
        }
    }
    return parts.join('\n');
}
// ── System Prompts ──
function analysisSystemPrompt(codebaseContext) {
    return `You are an expert software architect helping a developer understand their codebase.

<codebase>
${codebaseContext}
</codebase>

Analyze this codebase and provide:
1. Project purpose and type
2. Tech stack
3. Architecture overview
4. Code quality observations
5. Areas for improvement

At the end of your analysis, suggest 3-5 improvement directions using the format [SUGGESTION]suggestion text[/SUGGESTION] on separate lines. These will be rendered as clickable chips in the UI.

You can mix Korean and English naturally.`;
}
function directionSystemPrompt(analysisResult, chosenDirection) {
    return `You are helping plan a research/improvement direction for a software project.

<analysis>
${analysisResult}
</analysis>

The user has chosen this direction: ${chosenDirection}

Discuss:
1. Specific changes/experiments needed
2. Success metrics (measurable)
3. Risks and challenges
4. Implementation order

Use [SUGGESTION]action text[/SUGGESTION] to suggest specific next actions.
You can mix Korean and English naturally.`;
}
// ── SSE Helpers ──
function sseWrite(res, event) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
}
function sseHeaders(res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
}
// ── Session Store ──
const sessions = new Map();
function getSession(id) {
    return sessions.get(id);
}
function setSession(id, state) {
    sessions.set(id, state);
}
// ── Parse Suggestions from text ──
function parseSuggestions(text) {
    const regex = /\[SUGGESTION\](.*?)\[\/SUGGESTION\]/gs;
    const suggestions = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        suggestions.push(match[1].trim());
    }
    return suggestions;
}
// ── Client Factory ──
function createClient(token) {
    // OAuth tokens (sk-ant-oat*) use Authorization: Bearer header
    if (token.startsWith('sk-ant-oat')) {
        return new Anthropic({ authToken: token, apiKey: '' });
    }
    // Regular API keys use x-api-key header
    return new Anthropic({ apiKey: token });
}
// ── Streaming Chat ──
export async function initChat(apiKey, projectDir, res) {
    sseHeaders(res);
    try {
        const codebaseContext = scanCodebase(projectDir);
        const systemPrompt = analysisSystemPrompt(codebaseContext);
        const client = createClient(apiKey);
        let fullText = '';
        const stream = client.messages.stream({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: 'user', content: 'Please analyze this codebase.' }],
        });
        stream.on('text', (text) => {
            fullText += text;
            sseWrite(res, { type: 'text_delta', content: text });
        });
        await stream.finalMessage();
        const suggestions = parseSuggestions(fullText);
        if (suggestions.length > 0) {
            sseWrite(res, { type: 'suggestions', items: suggestions });
        }
        sseWrite(res, { type: 'done', content: fullText });
        // Store session
        const state = {
            phase: 'analysis',
            messages: [
                { role: 'user', content: 'Please analyze this codebase.' },
                { role: 'assistant', content: fullText },
            ],
            codebaseContext,
            analysisResult: fullText,
        };
        setSession(projectDir, state);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        sseWrite(res, { type: 'error', message: msg });
    }
    res.end();
}
export async function sendMessage(apiKey, projectDir, userMessage, res) {
    sseHeaders(res);
    const state = getSession(projectDir);
    if (!state) {
        sseWrite(res, {
            type: 'error',
            message: 'No active session. Call /api/chat/init first.',
        });
        res.end();
        return;
    }
    state.messages.push({ role: 'user', content: userMessage });
    try {
        const systemPrompt = state.phase === 'analysis'
            ? analysisSystemPrompt(state.codebaseContext)
            : directionSystemPrompt(state.analysisResult ?? '', userMessage);
        const client = createClient(apiKey);
        let fullText = '';
        const stream = client.messages.stream({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4096,
            system: systemPrompt,
            messages: state.messages.map((m) => ({
                role: m.role,
                content: m.content,
            })),
        });
        stream.on('text', (text) => {
            fullText += text;
            sseWrite(res, { type: 'text_delta', content: text });
        });
        await stream.finalMessage();
        state.messages.push({ role: 'assistant', content: fullText });
        const suggestions = parseSuggestions(fullText);
        if (suggestions.length > 0) {
            sseWrite(res, { type: 'suggestions', items: suggestions });
        }
        sseWrite(res, { type: 'done', content: fullText });
        setSession(projectDir, state);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        sseWrite(res, { type: 'error', message: msg });
    }
    res.end();
}
export function advancePhase(projectDir, artDir) {
    const state = getSession(projectDir);
    if (!state) {
        return { ok: false, phase: 'analysis', error: 'No active session' };
    }
    const planDir = path.join(artDir, 'plan');
    fs.mkdirSync(planDir, { recursive: true });
    if (state.phase === 'analysis') {
        // Save ANALYSIS.md
        const analysisContent = state.analysisResult ??
            state.messages
                .filter((m) => m.role === 'assistant')
                .map((m) => m.content)
                .join('\n\n');
        fs.writeFileSync(path.join(planDir, 'ANALYSIS.md'), `# Codebase Analysis\n\n${analysisContent}\n`);
        // Transition to direction phase
        state.phase = 'direction';
        setSession(projectDir, state);
        return { ok: true, phase: 'direction' };
    }
    if (state.phase === 'direction') {
        // Save PLAN.md and METRICS.md from the conversation
        const assistantMessages = state.messages
            .filter((m) => m.role === 'assistant')
            .map((m) => m.content);
        // Last assistant message in direction phase is the plan
        const directionContent = assistantMessages[assistantMessages.length - 1] ?? '';
        // Extract metrics section if present, otherwise use full content
        const metricsMatch = directionContent.match(/(?:metrics|메트릭|성공 기준|success criteria)[:\s]*([\s\S]*?)(?:\n##|\n\d+\.|$)/i);
        const metricsContent = metricsMatch ? metricsMatch[1].trim() : '';
        fs.writeFileSync(path.join(planDir, 'PLAN.md'), `# Plan\n\n${directionContent}\n`);
        if (metricsContent) {
            fs.writeFileSync(path.join(planDir, 'METRICS.md'), `# Success Metrics\n\n${metricsContent}\n`);
        }
        // Clean up session
        sessions.delete(projectDir);
        return { ok: true, phase: 'complete' };
    }
    return { ok: false, phase: state.phase, error: 'Unknown phase' };
}
export function getChatState(projectDir, hasAuth) {
    const state = getSession(projectDir);
    return {
        hasAuth,
        phase: state?.phase ?? null,
        messageCount: state?.messages.length ?? 0,
    };
}
//# sourceMappingURL=llm-chat.js.map