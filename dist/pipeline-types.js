/**
 * Resolve the effective stage kind - explicit `kind` wins, otherwise infer
 * from presence of `command`.
 */
export function resolveStageKind(stage) {
    if (stage.kind)
        return stage.kind;
    return stage.command ? 'command' : 'agent';
}
//# sourceMappingURL=pipeline-types.js.map