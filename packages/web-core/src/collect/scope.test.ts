import { describe, expect, test } from "bun:test"
import { createScopeGuard, inCidr, isPrivateIp, ScopeViolation } from "./scope.js"

describe("host-glob scope", () => {
  const g = createScopeGuard({ hosts: ["acme.test", "*.acme.test"], denyPrivate: true })
  test("apex and subdomains allowed", () => {
    expect(g.allows({ host: "acme.test" })).toBe(true)
    expect(g.allows({ host: "app.acme.test" })).toBe(true)
    expect(g.allows({ host: "a.b.acme.test" })).toBe(true)
  })
  test("look-alike and other hosts denied", () => {
    expect(g.allows({ host: "acme.test.evil.com" })).toBe(false)
    expect(g.allows({ host: "notacme.test" })).toBe(false)
    expect(g.allows({ host: "evil.com" })).toBe(false)
  })
  test("assert throws for out-of-scope", () => {
    expect(() => g.assert({ host: "evil.com" })).toThrow(ScopeViolation)
    expect(() => g.assert({ host: "app.acme.test" })).not.toThrow()
  })
})

describe("port scoping", () => {
  const g = createScopeGuard({ hosts: ["*.acme.test"], ports: [443, 8443], denyPrivate: true })
  test("only listed ports pass", () => {
    expect(g.allows({ host: "app.acme.test", port: 443 })).toBe(true)
    expect(g.allows({ host: "app.acme.test", port: 22 })).toBe(false)
  })
})

describe("private-range defense", () => {
  const guard = createScopeGuard({ hosts: ["*.acme.test"], denyPrivate: true })
  test("cloud metadata + rfc1918 + loopback blocked", () => {
    expect(guard.allows({ host: "169.254.169.254" })).toBe(false)
    expect(guard.allows({ host: "10.1.2.3" })).toBe(false)
    expect(guard.allows({ host: "127.0.0.1" })).toBe(false)
    expect(guard.allows({ host: "localhost" })).toBe(false)
  })
  test("private ip allowed only when explicitly in a CIDR", () => {
    const net = createScopeGuard({ hosts: [], cidrs: ["10.0.0.0/8"], denyPrivate: true })
    expect(net.allows({ host: "10.1.2.3" })).toBe(true)
    expect(net.allows({ host: "192.168.1.1" })).toBe(false)
  })
})

describe("cidr + private helpers", () => {
  test("inCidr math", () => {
    expect(inCidr("10.1.2.3", "10.0.0.0/8")).toBe(true)
    expect(inCidr("11.0.0.1", "10.0.0.0/8")).toBe(false)
    expect(inCidr("172.16.5.5", "172.16.0.0/12")).toBe(true)
    expect(inCidr("172.32.0.1", "172.16.0.0/12")).toBe(false)
  })
  test("isPrivateIp", () => {
    expect(isPrivateIp("192.168.0.1")).toBe(true)
    expect(isPrivateIp("8.8.8.8")).toBe(false)
    expect(isPrivateIp("::1")).toBe(true)
  })
})
