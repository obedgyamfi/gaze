// @morgana/capture-store — durable capture persistence.
// Import a runtime-specific opener: "@morgana/capture-store/bun" (sidecar) or
// "@morgana/capture-store/node" (Electron desktop). The store + driver interface
// are exported here for advanced use.

export { SqliteCaptureStore } from "./store.js"
export type { SqliteDriver } from "./driver.js"
