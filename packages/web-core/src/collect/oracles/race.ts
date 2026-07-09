// ── Race-condition oracle ─────────────────────────────────────────────────────
// Fires N copies of a state-changing request concurrently (scheduler.burst) and
// confirms a race when more requests "succeed" than the action should allow once
// (limit-overrun: coupon reuse, balance double-spend, once-only enforcement bypass).
// The `send` is injected so the oracle stays pure/testable; the host supplies a
// scope-checked raw sender that bypasses the rate limiter for true concurrency.

import type { OracleEvidence, VulnClass } from "../../types.js"
import { stampEvidenceId } from "../../stores.js"
import type { Oracle, OracleCtx } from "../types.js"

export interface RaceResult {
  status: number
  length: number
  ms: number
  captureId?: string
}

export interface RaceCandidate {
  n: number
  send: (signal: AbortSignal) => Promise<RaceResult>
  vulnClass?: VulnClass
  nodeId?: string
  /** What counts as a successful (accepted) action. Default: status < 400. */
  isSuccess?: (r: RaceResult) => boolean
  /** How many successes are legitimate. Default 1 (once-only). */
  expectedSuccesses?: number
}

export const raceOracle: Oracle<RaceCandidate> = {
  id: "race",
  vulnClass: "access-control",
  async confirm(cand: RaceCandidate, ctx: OracleCtx): Promise<OracleEvidence | null> {
    const isSuccess = cand.isSuccess ?? ((r) => r.status < 400)
    const expected = cand.expectedSuccesses ?? 1
    const n = Math.max(2, cand.n)

    const settled = await ctx.scheduler.burst(
      Array.from({ length: n }, () => cand.send),
      { signal: ctx.signal },
    )
    const oks = settled
      .filter((s): s is PromiseFulfilledResult<RaceResult> => s.status === "fulfilled")
      .map((s) => s.value)
      .filter(isSuccess)

    if (oks.length <= expected) return null

    const signal = `${oks.length}/${n} concurrent requests accepted (expected ${expected}) — race condition`
    const baseline = oks[0]
    const test = oks[oks.length - 1]
    const baselineCaptureId = baseline.captureId ?? "race-baseline"
    const testCaptureId = test.captureId ?? "race-test"
    return {
      id: stampEvidenceId(baselineCaptureId, testCaptureId, "positive", signal),
      verdict: "positive",
      signal,
      baseline: { status: baseline.status, ms: baseline.ms, length: baseline.length },
      test: { status: test.status, ms: test.ms, length: test.length },
      baselineCaptureId,
      testCaptureId,
      vulnClass: cand.vulnClass ?? "access-control",
      nodeId: cand.nodeId,
      createdAt: Date.now(),
      graphVersion: 0,
    }
  },
}
