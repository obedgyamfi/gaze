import { describe, expect, test } from "bun:test"
import { createScheduler } from "../scheduler.js"
import { createScopeGuard } from "../scope.js"
import type { OracleCtx } from "../types.js"
import { raceOracle, type RaceResult } from "./race.js"

const ctx = (): OracleCtx => ({
  scope: createScopeGuard({ hosts: ["a.test"], denyPrivate: true }),
  net: { fetch: async () => ({ status: 200, headers: {}, body: "", bytes: 0, ms: 1, finalUrl: "" }) },
  scheduler: createScheduler({ defaultRps: 1000 }),
  signal: new AbortController().signal,
})

describe("raceOracle", () => {
  test("confirms when more requests succeed than the once-only limit", async () => {
    const send = async (): Promise<RaceResult> => ({ status: 200, length: 10, ms: 1 })
    const ev = await raceOracle.confirm({ n: 5, send }, ctx())
    expect(ev).not.toBeNull()
    expect(ev!.verdict).toBe("positive")
    expect(ev!.signal).toContain("race condition")
  })

  test("no finding when only one request is accepted (limit enforced)", async () => {
    let served = 0
    const send = async (): Promise<RaceResult> => {
      const first = served === 0
      served++
      return { status: first ? 200 : 409, length: 10, ms: 1 }
    }
    const ev = await raceOracle.confirm({ n: 5, send }, ctx())
    expect(ev).toBeNull()
  })
})
