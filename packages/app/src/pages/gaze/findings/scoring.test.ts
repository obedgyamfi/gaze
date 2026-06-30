import { describe, expect, test } from "bun:test"
import { riskSummary, severityMeta, severityRank, vulnRef } from "./scoring"

describe("riskSummary", () => {
  test("empty → zeroed, no dominant", () => {
    const r = riskSummary([])
    expect(r.score).toBe(0)
    expect(r.total).toBe(0)
    expect(r.dominant).toBeUndefined()
    expect(r.counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0, info: 0 })
  })

  test("counts, weighted score, and dominant = highest present", () => {
    const r = riskSummary([{ severity: "high" }, { severity: "medium" }, { severity: "medium" }, { severity: "low" }])
    expect(r.counts).toEqual({ critical: 0, high: 1, medium: 2, low: 1, info: 0 })
    expect(r.total).toBe(4)
    expect(r.score).toBe(12 + 5 + 5 + 1) // high 12 + medium*2 (10) + low 1
    expect(r.dominant).toBe("high")
  })

  test("score caps at 100", () => {
    const many = Array.from({ length: 10 }, () => ({ severity: "critical" }))
    expect(riskSummary(many).score).toBe(100) // 10*25 capped
  })
})

describe("severityMeta / severityRank", () => {
  test("known severity → its band + color", () => {
    expect(severityMeta("critical").cvss).toBe(9.8)
    expect(severityMeta("high").color).toBe("#ea580c")
  })
  test("unknown severity → info fallback", () => {
    expect(severityMeta("bogus").key).toBe("info")
  })
  test("rank orders critical < info", () => {
    expect(severityRank("critical")).toBeLessThan(severityRank("info"))
  })
})

describe("vulnRef (from the seed KB)", () => {
  test("idor resolves to a procedure with WSTG refs", () => {
    const r = vulnRef("idor")
    expect(r).toBeDefined()
    expect(r!.refs.join(" ")).toContain("WSTG-ATHZ-04")
    expect(r!.steps.length).toBeGreaterThan(0)
  })
  test("unknown vuln class → undefined", () => {
    expect(vulnRef("not-a-class")).toBeUndefined()
  })
})
