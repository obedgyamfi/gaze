// ── Collector / Oracle contracts ──────────────────────────────────────────────
// Two seams the whole BB surface plugs into. A Collector discovers surface and emits
// normalized Observations (folded into the SPG). An Oracle confirms a candidate into
// OracleEvidence (or null — never a false positive). Both receive scoped egress + the
// scheduler via ctx; neither is allowed to touch the network any other way.

import type { OracleEvidence, VulnClass } from "../types.js"
import type { Stores } from "../stores.js"
import type { ScopeGuard, Target } from "./scope.js"
import type { Scheduler } from "./scheduler.js"

// ── scoped egress (the ONLY http a collector/oracle may use) ──
export interface HttpReq {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string
  /** Replay a capture's real auth server-side (credential never surfaces). */
  replayCaptureId?: string
  /** Cap the body bytes read for analysis (perf/DoS guard). */
  maxBytes?: number
  signal?: AbortSignal
}
export interface HttpRes {
  status: number
  headers: Record<string, string>
  /** Possibly truncated to maxBytes. */
  body: string
  bytes: number
  ms: number
  /** The final URL after redirects (each hop is re-scope-checked). */
  finalUrl: string
}
export interface ScopedHttp {
  fetch(req: HttpReq): Promise<HttpRes>
}

// ── observations (collector → SPG) ──
export type Provenance = { collector: string; sourceUrl?: string; at: number }
export type SecretClass = "aws" | "gcp" | "jwt" | "apikey" | "bearer" | "private-key" | "generic"
export interface SecretRefObs {
  /** Fingerprint of the secret — NEVER the raw value. */
  hash: string
  class: SecretClass
  entropy: number
}
export interface ParamObs {
  name: string
  loc: "query" | "body" | "header" | "path"
}

export type Observation =
  | { kind: "endpoint"; method: string; url: string; via: Provenance; params?: ParamObs[] }
  | { kind: "param"; endpointId: string; param: ParamObs; via: Provenance }
  | { kind: "asset"; host: string; resolved?: string[]; via: Provenance }
  | { kind: "service"; host: string; port: number; proto: string; banner?: string; via: Provenance }
  | { kind: "cert"; host: string; sans: string[]; issuer: string; notAfter: number; via: Provenance }
  | { kind: "js"; url: string; endpoints: string[]; secrets: SecretRefObs[]; via: Provenance }
  | { kind: "secret"; ref: SecretRefObs; location: string; via: Provenance }
  | { kind: "takeover"; host: string; service: string; fingerprint: string; confidence: number; via: Provenance }

// ── collector ──
export interface CollectorEvent {
  collector: string
  message: string
  /** 0..1 when known. */
  progress?: number
}
export interface CollectorCtx {
  readonly scope: ScopeGuard
  readonly net: ScopedHttp
  readonly scheduler: Scheduler
  readonly emit: (obs: Observation) => void
  readonly workspace: Stores
  readonly signal: AbortSignal
  readonly log: (ev: CollectorEvent) => void
  /** Budgets so a collector self-limits (max pages/hosts/time). */
  readonly budget?: { maxItems?: number; maxMs?: number }
}
export interface CollectorResult {
  emitted: number
  truncated: boolean
}
export interface Collector<Cfg = unknown> {
  id: string
  run(ctx: CollectorCtx, cfg: Cfg): Promise<CollectorResult>
}

// ── oracle ──
export interface OracleCtx {
  readonly scope: ScopeGuard
  readonly net: ScopedHttp
  readonly scheduler: Scheduler
  readonly signal: AbortSignal
}
export interface Oracle<C = unknown> {
  id: string
  vulnClass: VulnClass
  confirm(candidate: C, ctx: OracleCtx): Promise<OracleEvidence | null>
}

export type { ScopeGuard, Target, Scheduler }
