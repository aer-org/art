import { AgentEngine, NormalizedEvent, RunTurnInput } from './types.js';
export declare class CodexEngine implements AgentEngine {
    runTurn(input: RunTurnInput): AsyncGenerator<NormalizedEvent>;
    private runTurnViaSdk;
    private runTurnViaLocalAppServer;
}
