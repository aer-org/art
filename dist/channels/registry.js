const registry = new Map();
export function registerChannel(name, factory) {
    registry.set(name, factory);
}
export function getChannelFactory(name) {
    return registry.get(name);
}
export function getRegisteredChannelNames() {
    return [...registry.keys()];
}
//# sourceMappingURL=registry.js.map