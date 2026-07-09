// ── ScopeGuard — the egress security kernel ───────────────────────────────────
// Deny-by-default authorization for every outbound target. No collector/oracle may
// open a connection except through a client that calls assert() first. Pure and
// exhaustively tested because this is the legal boundary of an authorized-testing
// tool: an out-of-scope request is a bug with real-world consequences.

export type Target = { host: string; port?: number; scheme?: string }

export interface ScopeRules {
  /** Host globs, e.g. "acme.test" or "*.acme.test" (matches the apex and any subdomain). */
  hosts: string[]
  /** IPv4 CIDRs, e.g. "10.0.0.0/8" — network module only. */
  cidrs?: string[]
  /** Allowed ports; empty/undefined ⇒ any port. */
  ports?: number[]
  /** Block RFC1918/loopback/link-local (incl. cloud metadata 169.254.169.254) and
   *  localhost unless explicitly listed. Defense against SSRF-to-internal & rebinding. */
  denyPrivate: boolean
}

export class ScopeViolation extends Error {
  constructor(readonly target: Target, message?: string) {
    super(message ?? `out of scope: ${target.host}${target.port != null ? ":" + target.port : ""}`)
    this.name = "ScopeViolation"
  }
}

export interface ScopeGuard {
  readonly rules: ScopeRules
  allows(t: Target): boolean
  /** Throws {@link ScopeViolation} when the target is not allowed. */
  assert(t: Target): void
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const PRIVATE_HOSTS = new Set(["localhost", "ip6-localhost", "metadata.google.internal"])
const PRIVATE_CIDRS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16", "0.0.0.0/8"]

export function isIpv4(h: string): boolean {
  const m = IPV4.exec(h)
  return m != null && m.slice(1).every((o) => Number(o) <= 255)
}

export function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => ((acc << 8) >>> 0) + (Number(o) & 255), 0) >>> 0
}

export function inCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf("/")
  if (slash < 0) return isIpv4(ip) && isIpv4(cidr) && ip === cidr
  const base = cidr.slice(0, slash)
  const bits = Number(cidr.slice(slash + 1))
  if (!isIpv4(ip) || !isIpv4(base) || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ipToInt(ip) & mask) === (ipToInt(base) & mask)
}

/** True for loopback / private / link-local IPv4 and common private IPv6 forms. */
export function isPrivateIp(host: string): boolean {
  const h = host.toLowerCase()
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true
  return isIpv4(h) && PRIVATE_CIDRS.some((c) => inCidr(h, c))
}

function hostMatches(host: string, glob: string): boolean {
  const h = host.toLowerCase()
  const g = glob.toLowerCase()
  if (g === h) return true
  if (g.startsWith("*.")) {
    const base = g.slice(2)
    return h === base || h.endsWith("." + base)
  }
  return false
}

/** A ScopeGuard whose host allow-list is read LIVE on every check, so a scope edited at
 *  runtime (e.g. from the desktop's Web → Scope panel, persisted to the workspace db)
 *  takes effect on the next request without restarting the process that holds the guard.
 *  Delegates to createScopeGuard per call — host lists are tiny, so rebuilding is cheap. */
export function createDynamicScopeGuard(getHosts: () => string[], denyPrivate = true): ScopeGuard {
  return {
    get rules(): ScopeRules {
      return { hosts: getHosts(), denyPrivate }
    },
    allows(t) {
      return createScopeGuard({ hosts: getHosts(), denyPrivate }).allows(t)
    },
    assert(t) {
      createScopeGuard({ hosts: getHosts(), denyPrivate }).assert(t)
    },
  }
}

export function createScopeGuard(rules: ScopeRules): ScopeGuard {
  const hosts = rules.hosts.map((h) => h.toLowerCase())
  const explicitHost = (h: string) => hosts.includes(h) || (rules.cidrs ?? []).some((c) => inCidr(h, c))

  const allows = (t: Target): boolean => {
    const host = t.host.toLowerCase().replace(/\.$/, "")
    if (!host) return false
    if (t.port != null && rules.ports && rules.ports.length > 0 && !rules.ports.includes(t.port)) return false

    if (isIpv4(host)) {
      const explicit = explicitHost(host)
      if (rules.denyPrivate && isPrivateIp(host) && !explicit) return false
      // For raw IPs, require an explicit allowance (a CIDR/host) OR a host-glob match is impossible.
      return explicit
    }

    if (rules.denyPrivate && PRIVATE_HOSTS.has(host) && !hosts.includes(host)) return false
    return hosts.some((g) => hostMatches(host, g))
  }

  return {
    rules,
    allows,
    assert(t) {
      if (!allows(t)) throw new ScopeViolation(t)
    },
  }
}
