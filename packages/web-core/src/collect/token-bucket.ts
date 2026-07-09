// ── Token bucket (pure) ───────────────────────────────────────────────────────
// Per-host rate limiting math, separated from the scheduler so it is deterministic
// and unit-testable. Politeness is both an ethics and a WAF-survival requirement.

export interface Bucket {
  tokens: number
  /** epoch ms of the last refill. */
  last: number
}

export function newBucket(capacity: number, now: number): Bucket {
  return { tokens: capacity, last: now }
}

export function refill(b: Bucket, now: number, rps: number, capacity: number): Bucket {
  const elapsed = Math.max(0, now - b.last)
  const tokens = Math.min(capacity, b.tokens + (elapsed / 1000) * rps)
  return { tokens, last: now }
}

export interface Take {
  ok: boolean
  bucket: Bucket
  /** ms to wait until `cost` tokens are available (0 when ok). */
  waitMs: number
}

export function take(b: Bucket, now: number, rps: number, capacity: number, cost = 1): Take {
  const r = refill(b, now, rps, capacity)
  if (r.tokens >= cost) return { ok: true, bucket: { tokens: r.tokens - cost, last: now }, waitMs: 0 }
  const deficit = cost - r.tokens
  const waitMs = rps > 0 ? Math.ceil((deficit / rps) * 1000) : Number.POSITIVE_INFINITY
  return { ok: false, bucket: r, waitMs }
}
