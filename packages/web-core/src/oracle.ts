// ── Oracle — the deterministic differential checker (the moat) ────────────────
// Ported verbatim in spirit from exodus/src/main/agent/oracle.ts. The SINGLE
// source of positive vs negative: a worker proposes, but only observable
// differences between a baseline and a test response produce a verdict. The model
// never decides this — it cannot fake a signal it didn't actually cause.
//
// CONSERVATIVE: returns `positive` only on unambiguous signals (planted canary,
// auth boundary crossed, same session reading two owners' resources). Suggestive-
// but-ambiguous signals (size/time swings) return `inconclusive` for human/triage.
// Pure: snapshots in → { verdict, signal } out. The boundary stamps the evidence.

import type { OracleSnapshot, OracleVerdict } from "./types.js"

const TIME_ANOMALY_MS = 5000
const TIME_ANOMALY_RATIO = 3
const SIZE_ANOMALY_RATIO = 1.5

function statusClass(code: number): number {
  return Math.floor(code / 100)
}

export interface OracleRuling {
  verdict: OracleVerdict
  signal: string
}

export function differential(
  baseline: OracleSnapshot,
  test: OracleSnapshot,
  opts: { markerPlanted?: boolean; crossUser?: boolean } = {},
): OracleRuling {
  const mk = (verdict: OracleVerdict, signal: string): OracleRuling => ({ verdict, signal })

  const bClass = statusClass(baseline.status)
  const tClass = statusClass(test.status)

  // 1. Reflected canary — the strongest signal. A marker we planted in the test
  //    request appears in the test response but not the baseline response.
  if (opts.markerPlanted && test.marker && !baseline.marker) {
    return mk("positive", `planted canary reflected in response (${test.marker})`)
  }

  // 2. Horizontal IDOR — the SAME authenticated session requested a different
  //    owner's resource (crossUser). Both succeed and the bodies differ ⇒ one
  //    session read two distinct resources it shouldn't co-own.
  if (opts.crossUser && bClass === 2 && tClass === 2 && baseline.bodyHash && test.bodyHash && baseline.bodyHash !== test.bodyHash) {
    return mk("positive", `same session served two different resources (${baseline.length}B vs ${test.length}B) — horizontal IDOR`)
  }

  // 3. Access-control boundary crossed: baseline denied, test allowed.
  const denied = baseline.status === 401 || baseline.status === 403
  if (denied && tClass === 2) {
    return mk("positive", `access boundary crossed: ${baseline.status} → ${test.status}`)
  }

  // 3b. Auth regression the other way (test newly denied) — not a vuln.
  if (bClass === 2 && (test.status === 401 || test.status === 403)) {
    return mk("negative", `test denied (${test.status}) where baseline allowed`)
  }

  // 4. Timing anomaly — suggestive of blind/time-based injection. Defer.
  if (test.ms - baseline.ms > TIME_ANOMALY_MS && test.ms > baseline.ms * TIME_ANOMALY_RATIO) {
    return mk("inconclusive", `response time spiked ${baseline.ms}ms → ${test.ms}ms`)
  }

  // 5. Large size swing on otherwise-equal status — possible data exposure. Defer.
  if (bClass === 2 && tClass === 2 && baseline.length > 0) {
    const ratio = test.length / baseline.length
    if (ratio >= SIZE_ANOMALY_RATIO || ratio <= 1 / SIZE_ANOMALY_RATIO) {
      return mk("inconclusive", `response size changed ${baseline.length}B → ${test.length}B`)
    }
  }

  return mk("negative", `no security-relevant difference (status ${baseline.status} vs ${test.status})`)
}
