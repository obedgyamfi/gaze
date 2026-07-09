import { describe, expect, test } from "bun:test"
import { createScheduler } from "../scheduler.js"
import { createScopeGuard } from "../scope.js"
import type { OracleCtx } from "../types.js"
import { logicOracle, type LogicScenario, type LogicStepResult } from "./logic.js"

const ctx = (): OracleCtx => ({
  scope: createScopeGuard({ hosts: ["a.test"], denyPrivate: true }),
  net: { fetch: async () => ({ status: 200, headers: {}, body: "", bytes: 0, ms: 1, finalUrl: "" }) },
  scheduler: createScheduler({ defaultRps: 1000 }),
  signal: new AbortController().signal,
})

const step = (name: string, status: number, body: string): LogicScenario["steps"][number] => ({
  name,
  send: async (): Promise<LogicStepResult> => ({ name, status, length: body.length, ms: 1, body }),
})

describe("logicOracle", () => {
  test("confirms when the invariant is violated (workflow bypass)", async () => {
    const scenario: LogicScenario = {
      steps: [step("apply-coupon", 200, "ok"), step("apply-coupon-again", 200, "ok")],
      invariant: (r) => {
        const applied = r.filter((x) => x.status === 200).length
        return { held: applied <= 1, signal: `coupon applied ${applied}× (should be once)` }
      },
    }
    const ev = await logicOracle.confirm(scenario, ctx())
    expect(ev).not.toBeNull()
    expect(ev!.signal).toContain("coupon applied 2")
  })

  test("no finding when the invariant holds", async () => {
    const scenario: LogicScenario = {
      steps: [step("checkout", 200, "ok")],
      invariant: () => ({ held: true, signal: "ok" }),
    }
    expect(await logicOracle.confirm(scenario, ctx())).toBeNull()
  })

  test("steps see prior results", async () => {
    const seen: number[] = []
    const scenario: LogicScenario = {
      steps: [
        step("a", 200, "x"),
        { name: "b", send: async (_s, prior) => {
          seen.push(prior.length)
          return { name: "b", status: 200, length: 1, ms: 1 }
        } },
      ],
      invariant: () => ({ held: true, signal: "" }),
    }
    await logicOracle.confirm(scenario, ctx())
    expect(seen).toEqual([1]) // step b saw 1 prior result
  })
})
