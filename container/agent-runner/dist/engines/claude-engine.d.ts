import { AgentEngine, NormalizedEvent, RunTurnInput } from './types.js';
export declare class ClaudeEngine implements AgentEngine {
    runTurn(input: RunTurnInput): AsyncGenerator<NormalizedEvent>;
}
