// ── @morgana/web-core/collect ─────────────────────────────────────────────────
// The BB module seams: a security kernel (ScopeGuard), a work scheduler, the
// Collector/Oracle contracts, observation→SPG ingest, and registries. Every network
// feature (crawler, discovery, recon, api-import, auth-matrix, race, logic, takeover,
// watch) is a thin plug-in over these — see docs/BB_MODULES.md.

export {
  type Target,
  type ScopeRules,
  type ScopeGuard,
  ScopeViolation,
  createScopeGuard,
  isIpv4,
  ipToInt,
  inCidr,
  isPrivateIp,
} from "./scope.js"

export { type Bucket, newBucket, refill, take, type Take } from "./token-bucket.js"
export { type Scheduler, type SchedulerConfig, type HostBudget, type TaskOpts, createScheduler } from "./scheduler.js"

export type {
  HttpReq,
  HttpRes,
  ScopedHttp,
  Provenance,
  SecretClass,
  SecretRefObs,
  ParamObs,
  Observation,
  CollectorEvent,
  CollectorCtx,
  CollectorResult,
  Collector,
  OracleCtx,
  Oracle,
} from "./types.js"

export { foldObservation } from "./ingest.js"
export { type Registry, createRegistry, type CollectorRegistry, type OracleRegistry } from "./registry.js"

// ── analysis + collectors ──
export { shannonEntropy, detectSecrets, extractEndpoints } from "./analyze-js.js"
export { extractLinks, extractForms, extractScripts, type FormObs } from "./analyze-html.js"
export { jsAnalyzerCollector, type JsAnalyzerConfig } from "./collectors/js-analyzer.js"
export { crawlerCollector, type CrawlerConfig } from "./collectors/crawler.js"
export { contentDiscoveryCollector, isHit, type ContentDiscoveryConfig } from "./collectors/content-discovery.js"
export { paramMinerCollector, type ParamMinerConfig } from "./collectors/param-miner.js"
export { subdomainTakeoverCollector, type TakeoverConfig } from "./collectors/subdomain-takeover.js"
export { matchTakeover, TAKEOVER_FINGERPRINTS, type TakeoverMatch, type TakeoverFingerprint } from "./takeover-fingerprints.js"
export { parseOpenApi, parseGraphqlIntrospection, detectSchemaKind, type ParsedEndpoint } from "./api-schema.js"
export { apiSchemaCollector, type ApiSchemaConfig } from "./collectors/api-schema.js"

// ── oracles ──
export { raceOracle, type RaceCandidate, type RaceResult } from "./oracles/race.js"
export { logicOracle, type LogicScenario, type LogicStep, type LogicStepResult } from "./oracles/logic.js"
