// ── Business-logic oracle ─────────────────────────────────────────────────────
// Runs an agent-authored ordered scenario (each step can see prior results) and
// confirms a finding when a declared invariant is violated — the class of workflow
// bugs (price tampering, step-skipping, negative balance, IDOR-in-workflow) that
// signature scanners can't reach. Steps/invariant are injected → pure and testable.

import type { OracleEvidence, VulnClass } from "../../types.js"
import { stampEvidenceId } from "../../stores.js"
import type { Oracle, OracleCtx } from "../types.js"

export interface LogicStepResult {
  name: string
  status: number
  length: number
  ms: number
  body?: string
  captureId?: string
}

export interface LogicStep {
  name: string
  send: (signal: AbortSignal, prior: LogicStepResult[]) => Promise<LogicStepResult>
}

export interface LogicScenario {
  steps: LogicStep[]
  /** Property that MUST hold; when it doesn't, that's the finding. */
  invariant: (results: LogicStepResult[]) => { held: boolean; signal: string }
  vulnClass?: VulnClass
  nodeId?: string
}

export const logicOracle: Oracle<LogicScenario> = {
  id: "logic",
  vulnClass: "access-control",
  async confirm(scenario: LogicScenario, ctx: OracleCtx): Promise<OracleEvidence | null> {
    const results: LogicStepResult[] = []
    for (const step of scenario.steps) {
      if (ctx.signal.aborted) return null
      results.push(await step.send(ctx.signal, results))
    }
    if (results.length === 0) return null

    const inv = scenario.invariant(results)
    if (inv.held) return null

    const baseline = results[0]
    const test = results[results.length - 1]
    if (!baseline || !test) return null
    const baselineCaptureId = baseline.captureId ?? `logic-${baseline.name}`
    const testCaptureId = test.captureId ?? `logic-${test.name}`
    return {
      id: stampEvidenceId(baselineCaptureId, testCaptureId, "positive", inv.signal),
      verdict: "positive",
      signal: inv.signal,
      baseline: { status: baseline.status, ms: baseline.ms, length: baseline.length },
      test: { status: test.status, ms: test.ms, length: test.length },
      baselineCaptureId,
      testCaptureId,
      vulnClass: scenario.vulnClass ?? "access-control",
      nodeId: scenario.nodeId,
      createdAt: Date.now(),
      graphVersion: 0,
    }
  },
}
