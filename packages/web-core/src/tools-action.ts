// ── Action surface — the proof loop ───────────────────────────────────────────
// propose (web_replay_plan) → host fires → adjudicate (web_oracle_check / web_replay)
// → record (web_finding_propose, gated on positive evidence; web_note_add).
// The oracle is deterministic and host-agnostic; firing tools depend on ctx.fire
// (assisted mode) and refuse without it. See gaze/docs/MCP_ACTION_SURFACE.md.

import { createHash } from "node:crypto"
import { z } from "zod"
import { defineTool, out, type HandlerCtx, type ToolSpec } from "./tools.js"
import { differential } from "./oracle.js"
import { stampEvidenceId } from "./stores.js"
import type { CaptureRecord } from "./capture-source.js"
import type { Finding, Note, OracleEvidence, OracleSnapshot } from "./types.js"

const VULN_CLASSES = ["auth", "idor", "access-control", "injection", "xss", "cors", "ssrf", "info-leak", "csrf"] as const
const SEVERITY = ["info", "low", "medium", "high", "critical"] as const

async function findCapture(ctx: HandlerCtx, id: string): Promise<CaptureRecord | undefined> {
  return (await ctx.captureSource.list()).find((c) => c.id === id)
}

async function snapshotOf(ctx: HandlerCtx, c: CaptureRecord, marker?: string): Promise<OracleSnapshot> {
  const body = await ctx.captureSource.getBody(c.id, "response")
  const bodyHash = body ? createHash("sha256").update(body.base64).digest("hex") : undefined
  return {
    status: c.status ?? 0,
    ms: c.durationMs ?? 0,
    length: c.responseBody?.size ?? body?.size ?? 0,
    bodyHash,
    marker: marker && body?.text?.includes(marker) ? marker : undefined,
  }
}

function assertInScope(url: string, scopeHosts: string[]): void {
  if (scopeHosts.length === 0) return
  let host = ""
  try {
    host = new URL(url).host
  } catch {
    return
  }
  if (!scopeHosts.some((s) => host === s || host.endsWith("." + s))) throw new Error(`Host '${host}' is out of engagement scope.`)
}

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"])

/** Returns a refusal reason if a state-changing verb isn't armed, else null. */
async function requireArming(ctx: HandlerCtx, method: string, what: string): Promise<string | null> {
  if (!STATE_CHANGING.has(method.toUpperCase())) return null
  if (!ctx.ask) return `${method} is state-changing and requires operator arming, which is unavailable in this mode`
  const ok = await ctx.ask({ permission: "web.http.write", reason: what })
  return ok ? null : `operator declined to arm: ${what}`
}

function applyMutationToUrl(url: string, m: { kind: string; target: string; value: string }): string {
  if (m.kind === "query_param") {
    try {
      const u = new URL(url)
      u.searchParams.set(m.target, m.value)
      return u.toString()
    } catch {
      return url
    }
  }
  if (m.kind === "path_param") return url.replace(m.target, m.value)
  return url
}

export const ACTION_TOOLS: ToolSpec[] = [
  defineTool({
    name: "web_replay_plan",
    description:
      "Propose a mutation of an in-scope baseline capture as an abstract replay plan — NO secret. Names headers to preserve by name only. The host fires it (reusing the real session); then adjudicate with web_replay / web_oracle_check.",
    readOnly: true,
    args: {
      baseline_capture_id: z.string(),
      mutation: z.object({ kind: z.enum(["path_param", "query_param", "header", "body_field"]), target: z.string(), value: z.string() }),
      preserve_headers: z.array(z.string()).default([]),
      vuln_class: z.enum(VULN_CLASSES).optional(),
      expect: z.string().optional(),
    },
    async handler(args, ctx) {
      const base = await findCapture(ctx, args.baseline_capture_id)
      if (!base) return out("replay plan", { error: `no capture '${args.baseline_capture_id}'; list ids via web_graph_evidence` })
      return out("replay plan", {
        plan_id: `plan-${stampEvidenceId(base.id, args.mutation.target, "negative", args.mutation.value)}`,
        method: base.method,
        url_template: applyMutationToUrl(base.url, args.mutation),
        mutation: args.mutation,
        preserve_headers: args.preserve_headers,
        success_criteria: args.expect ?? "baseline vs test differ per the oracle",
        vuln_class: args.vuln_class,
      })
    },
  }),

  defineTool({
    name: "web_oracle_check",
    description:
      "Deterministic differential over two captures (baseline vs test). RULES positive/negative/inconclusive — the model cannot. Persists frozen, content-addressed evidence and returns its id for web_finding_propose.",
    readOnly: false,
    args: {
      baseline_capture_id: z.string(),
      test_capture_id: z.string(),
      marker: z.string().optional().describe("Canary planted in the test request, if any."),
      cross_user: z.boolean().optional().describe("True for IDOR: same session, different owner's id."),
      vuln_class: z.enum(VULN_CLASSES).optional(),
      node_id: z.string().optional(),
    },
    async handler(args, ctx) {
      const a = await findCapture(ctx, args.baseline_capture_id)
      const b = await findCapture(ctx, args.test_capture_id)
      if (!a || !b) return out("oracle check", { error: "baseline and test capture ids must both exist" })
      const baseline = await snapshotOf(ctx, a, args.marker)
      const test = await snapshotOf(ctx, b, args.marker)
      const ruling = differential(baseline, test, { markerPlanted: Boolean(args.marker), crossUser: args.cross_user })
      const id = stampEvidenceId(a.id, b.id, ruling.verdict, ruling.signal)
      const evidence: OracleEvidence = {
        id, verdict: ruling.verdict, signal: ruling.signal, baseline, test,
        baselineCaptureId: a.id, testCaptureId: b.id, vulnClass: args.vuln_class, nodeId: args.node_id,
        createdAt: Date.now(), graphVersion: (await ctx.captureSource.version?.()) ?? 0,
      }
      ctx.evidence.put(evidence)
      return out("oracle check", { verdict: evidence.verdict, signal: evidence.signal, evidence_id: id })
    },
  }),

  defineTool({
    name: "web_finding_propose",
    description:
      "Create a DRAFT finding, GATED on a POSITIVE oracle-evidence id. Freezes the evidence into the finding — the agent cannot file what it didn't prove.",
    readOnly: false,
    args: {
      node_id: z.string().optional(),
      vuln_class: z.enum(VULN_CLASSES),
      severity: z.enum(SEVERITY),
      title: z.string(),
      detail: z.string(),
      evidence_id: z.string(),
    },
    async handler(args, ctx) {
      const ev = ctx.evidence.get(args.evidence_id)
      if (!ev) return out("finding propose", { error: `no evidence '${args.evidence_id}'; run web_oracle_check / web_replay first` })
      if (ev.verdict !== "positive") return out("finding propose", { error: `evidence '${args.evidence_id}' is '${ev.verdict}' — a finding needs a positive verdict` })
      const id = `find-${createHash("sha1").update(`${args.evidence_id}:${args.title}`).digest("hex").slice(0, 12)}`
      const finding: Finding = {
        id, status: "draft", nodeId: args.node_id ?? ev.nodeId, vulnClass: args.vuln_class, severity: args.severity,
        title: args.title, detail: args.detail, evidenceId: ev.id, evidence: ev, createdAt: Date.now(),
      }
      ctx.findings.put(finding)
      return out("finding propose", { finding_id: id, status: "draft" })
    },
  }),

  defineTool({
    name: "web_note_add",
    description: "Attach a non-authoritative investigative note to a node. Does not mutate the graph; for observations to confirm later.",
    readOnly: false,
    args: { node_id: z.string().optional(), text: z.string(), tags: z.array(z.string()).default([]) },
    async handler(args, ctx) {
      const id = `note-${createHash("sha1").update(`${args.node_id ?? ""}:${args.text}:${Date.now()}`).digest("hex").slice(0, 12)}`
      const note: Note = { id, nodeId: args.node_id, text: args.text, tags: args.tags, createdAt: Date.now() }
      ctx.notes.put(note)
      return out("note add", { note_id: id })
    },
  }),

  defineTool({
    name: "web_http_send",
    description:
      "Fire one scoped HTTP request against the live target (assisted mode). The host attaches the session; the model never sees credentials. State-changing verbs require operator arming. Returns the resulting capture id.",
    readOnly: false,
    args: { method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()).optional(), body: z.string().optional() },
    async handler(args, ctx) {
      if (!ctx.fire) return out("http send", { error: "live firing is not available in this mode (assisted-only)" })
      assertInScope(args.url, ctx.scopeHosts)
      const denied = await requireArming(ctx, args.method, `${args.method} ${args.url}`)
      if (denied) return out("http send", { error: denied })
      const r = await ctx.fire({ method: args.method, url: args.url, headers: args.headers, body: args.body })
      return out("http send", { capture_id: r.captureId, status: r.status, ms: r.ms })
    },
  }),

  defineTool({
    name: "web_replay",
    description:
      "Replay an in-scope baseline capture with substitutions (the host reuses the baseline's real session), then run the oracle vs the baseline. Assisted mode. Returns the verdict + evidence id.",
    readOnly: false,
    args: {
      baseline_capture_id: z.string(),
      substitutions: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
      marker: z.string().optional(),
      cross_user: z.boolean().optional(),
      vuln_class: z.enum(VULN_CLASSES).optional(),
    },
    async handler(args, ctx) {
      if (!ctx.fire) return out("replay", { error: "live firing is not available in this mode (assisted-only)" })
      const base = await findCapture(ctx, args.baseline_capture_id)
      if (!base) return out("replay", { error: `no capture '${args.baseline_capture_id}'` })
      assertInScope(base.url, ctx.scopeHosts)
      const denied = await requireArming(ctx, base.method, `replay ${base.method} ${base.url}`)
      if (denied) return out("replay", { error: denied })
      const fired = await ctx.fire({ method: base.method, url: base.url, replayCaptureId: base.id, substitutions: args.substitutions, marker: args.marker })
      const baseline = await snapshotOf(ctx, base, args.marker)
      const test: OracleSnapshot = { status: fired.status, ms: fired.ms, length: 0, bodyHash: fired.bodyHash, marker: fired.marker }
      const ruling = differential(baseline, test, { markerPlanted: Boolean(args.marker), crossUser: args.cross_user })
      const id = stampEvidenceId(base.id, fired.captureId, ruling.verdict, ruling.signal)
      ctx.evidence.put({
        id, verdict: ruling.verdict, signal: ruling.signal, baseline, test,
        baselineCaptureId: base.id, testCaptureId: fired.captureId, vulnClass: args.vuln_class,
        createdAt: Date.now(), graphVersion: (await ctx.captureSource.version?.()) ?? 0,
      })
      return out("replay", { verdict: ruling.verdict, signal: ruling.signal, evidence_id: id, test_capture_id: fired.captureId })
    },
  }),
]
