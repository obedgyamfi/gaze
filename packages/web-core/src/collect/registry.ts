// ── Collector / Oracle registries ─────────────────────────────────────────────
// A host builds the set of enabled collectors/oracles once and looks them up by id.
// Keeping registration explicit (no global mutable singletons) keeps the engine pure
// and testable — each workspace/run can compose its own registry.

import type { Collector, Oracle } from "./types.js"

export interface Registry<T extends { id: string }> {
  register(item: T): void
  get(id: string): T | undefined
  list(): T[]
}

export function createRegistry<T extends { id: string }>(initial: T[] = []): Registry<T> {
  const map = new Map<string, T>()
  for (const it of initial) map.set(it.id, it)
  return {
    register: (item) => void map.set(item.id, item),
    get: (id) => map.get(id),
    list: () => [...map.values()],
  }
}

export type CollectorRegistry = Registry<Collector<never>>
export type OracleRegistry = Registry<Oracle<never>>
