import { describe, expect, test } from "bun:test"
import { detectSecrets, extractEndpoints, shannonEntropy } from "./analyze-js.js"

describe("shannonEntropy", () => {
  test("low for repetition, higher for random", () => {
    expect(shannonEntropy("aaaaaaaa")).toBe(0)
    expect(shannonEntropy("a8Xk2Lp9Qz")).toBeGreaterThan(3)
  })
})

describe("detectSecrets", () => {
  test("finds AWS keys and JWTs as refs (never the raw value)", () => {
    const text = `const k="AKIAIOSFODNN7EXAMPLE"; const t="eyJhbGciOi.eyJzdWIiOjEyMzQ1.SflKxwRJSMeKKF2QT4";`
    const s = detectSecrets(text)
    const classes = s.map((x) => x.class)
    expect(classes).toContain("aws")
    expect(classes).toContain("jwt")
    for (const ref of s) {
      expect(ref.hash.length).toBeGreaterThan(0)
      expect((ref as unknown as { value?: string }).value).toBeUndefined()
    }
    expect(JSON.stringify(s)).not.toContain("AKIAIOSFODNN7EXAMPLE")
  })

  test("high-entropy generic assignment detected, low-entropy skipped", () => {
    expect(detectSecrets(`apiKey: "aB3xK9zLmQ7wR2pT"`).length).toBe(1)
    expect(detectSecrets(`password: "aaaaaaaaaaaa"`).length).toBe(0) // low entropy
  })
})

describe("extractEndpoints", () => {
  test("absolute urls + relative paths resolved, assets dropped, deduped", () => {
    const js = `
      fetch("https://api.a.test/v1/users");
      axios.get("/api/orders/123");
      const img = "/logo.png";
      const dup = "https://api.a.test/v1/users";
      import("./chunk.js");
    `
    const eps = extractEndpoints(js, "https://app.a.test/")
    expect(eps).toContain("https://api.a.test/v1/users")
    expect(eps).toContain("https://app.a.test/api/orders/123")
    expect(eps.some((e) => e.endsWith(".png"))).toBe(false)
    expect(eps.filter((e) => e === "https://api.a.test/v1/users").length).toBe(1)
  })
})
