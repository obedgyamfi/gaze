import { describe, expect, test } from "bun:test"
import { newBucket, take } from "./token-bucket.js"
import { createScheduler } from "./scheduler.js"

describe("token bucket", () => {
  test("takes until empty then reports a wait", () => {
    let b = newBucket(2, 0)
    let r = take(b, 0, 2, 2)
    expect(r.ok).toBe(true)
    b = r.bucket
    r = take(b, 0, 2, 2)
    expect(r.ok).toBe(true)
    b = r.bucket
    r = take(b, 0, 2, 2)
    expect(r.ok).toBe(false)
    expect(r.waitMs).toBeGreaterThan(0)
  })
  test("refills over time", () => {
    const b = newBucket(0, 0)
    const r = take(b, 1000, 2, 2) // 1s at 2rps → 2 tokens
    expect(r.ok).toBe(true)
  })
})

describe("scheduler", () => {
  test("resolves every task and respects the host concurrency cap", async () => {
    const sched = createScheduler({ hostConcurrency: 3, globalConcurrency: 100, perHost: { h: { rps: 1000, concurrency: 3 } } })
    let active = 0
    let peak = 0
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        sched.submit(async () => {
          active++
          peak = Math.max(peak, active)
          await new Promise((r) => setTimeout(r, 5))
          active--
          return i
        }, { host: "h" }),
      ),
    )
    expect(results.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i))
    expect(peak).toBeLessThanOrEqual(3)
  })

  test("enforces global concurrency across hosts", async () => {
    const sched = createScheduler({ hostConcurrency: 10, globalConcurrency: 2, defaultRps: 1000 })
    let active = 0
    let peak = 0
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        sched.submit(async () => {
          active++
          peak = Math.max(peak, active)
          await new Promise((r) => setTimeout(r, 5))
          active--
        }, { host: `host-${i % 4}` }),
      ),
    )
    expect(peak).toBeLessThanOrEqual(2)
  })

  test("propagates task rejection", async () => {
    const sched = createScheduler()
    await expect(sched.submit(async () => { throw new Error("boom") }, { host: "h" })).rejects.toThrow("boom")
  })
})
