# BB modules — architecture & build contract

GAZE's bug-bounty surface is built as thin plug-ins over five shared **seams**. Get the
seams right and each feature is mostly mechanical. This is the contract; the seams live
in `@morgana/web-core/collect`.

## Design invariants (non-negotiable)

1. **Deny-by-default egress.** No module opens a connection except through a client that
   calls `ScopeGuard.assert()` first. This is the legal boundary of an authorized-testing tool.
2. **Secrets never enter the graph.** Producers emit a fingerprint ref (`SecretRefObs`), never
   the value; `foldObservation` only folds refs.
3. **Never execute target code.** JS/APK analysis is static-parse-only, in a worker with no network.
4. **One scheduler owns all outbound work.** Per-host rate + concurrency = ethics *and* WAF-survival.
5. **Incremental everything.** Collectors emit `Observation` deltas; the graph/UI never rematerialize.

## The five seams (`@morgana/web-core/collect`)

### 1. `ScopeGuard` — the egress security kernel (`scope.ts`)
`createScopeGuard(rules)` → `{ allows(t), assert(t) }`. Host globs (`*.acme.test` matches apex +
subdomains), IPv4 CIDRs (network module), optional port allow-list, and `denyPrivate` that blocks
RFC1918/loopback/link-local (incl. `169.254.169.254`) + `localhost` unless explicitly listed.
Pure and exhaustively tested. **Node runtime must additionally**: resolve hostnames and re-check the
IP with `isPrivateIp`, pin the resolved IP, and re-`assert` on every redirect hop (rebinding/SSRF defense).

### 2. `Scheduler` — the single owner of outbound work (`scheduler.ts` + `token-bucket.ts`)
`createScheduler(cfg).submit(task, { host, priority })`. Per-host token bucket (politeness) + per-host
and global concurrency caps + priority queue + `AbortSignal` cancellation. Clock/sleep injectable for
tests. Future: `burst(tasks, "single-packet")` as the race-condition primitive.

### 3. `Collector` — surface producers (`types.ts`)
`run(ctx, cfg)` where `ctx` provides `scope`, `net: ScopedHttp` (the **only** allowed HTTP),
`scheduler`, `emit(Observation)`, `workspace: Stores`, `signal`, `log`, `budget`. Capture, crawler,
content/param discovery, JS analysis, recon, api-schema import, subdomain-takeover are all Collectors.

`Observation` = `endpoint | param | asset | service | cert | js | secret | takeover` (see `types.ts`).

### 4. `Oracle` — finding confirmers (`types.ts`)
`confirm(candidate, ctx) → OracleEvidence | null` (null = not confirmed; **no false positives**).
Differential-replay (existing `oracle.ts`), race, logic, and (deferred) OAST are Oracles. Findings
continue to flow into the existing `FindingStore` → Findings dashboard → Report **unchanged**.

### 5. `foldObservation(graph, obs, now)` — observation → SPG (`ingest.ts`)
Idempotent merge into the enriched graph so the agent and UI see one attack surface. SPG deltas:
`NodeKind += Host | Service | Certificate | JsAsset | SecretRef`;
`EdgeKind += RESOLVES_TO | SERVES | EXPOSES_ENDPOINT | HOLDS_SECRET | TAKEOVER_CANDIDATE`.
Registries (`registry.ts`) compose the enabled collectors/oracles per run (no global singletons).

## Process model

- **Main (Node):** `ScopedHttp` (DNS-pinned), scheduler, network dialers. Streams progress to the
  renderer over the existing `*-subscribe` IPC.
- **utilityProcess worker pool (existing sidecar pattern):** CPU-heavy + untrusted parsing
  (JS AST/endpoint extraction, wordlist expansion, APK decode). **No network handle** in these workers.
- **web-core (pure):** collectors/oracles as pure orchestration over injected ctx — headless-testable.
- **Agent:** drives everything via MCP tools (`web_crawl`, `web_discover_content`, `web_analyze_js`,
  `web_identity_add`, `web_auth_matrix`, `web_import_openapi`, `web_race`, `web_scenario_run`,
  `recon_takeover_check`, `watch_add`, …).

## Feature → seam map

| Feature | Seam | Notes |
|---|---|---|
| Crawler + JS/content/param discovery | Collectors | biggest BB coverage win; JS parsed in worker |
| Auth multi-identity / role matrix | store + access-control Oracle | creds **encrypted at rest** (safeStorage), never in SPG/report |
| API & GraphQL | Collector (schema import) + Oracle | surfaces non-UI endpoints → BOLA/BFLA |
| Race conditions | Oracle over `scheduler.burst` | single-packet / last-byte sync |
| Business-logic | Oracle (agent-scripted) | multi-step scenario + invariant assertion |
| Subdomain takeover | Collector + tiny Oracle | dangling CNAME fingerprinting |
| Watch mode | scheduled Collector runs + diff store | jittered; being first = fewer dupes |
| OAST (**deferred**) | Oracle + OobService | needs hosted callback infra |

## Build order

1. **Seams** (`collect/`) — done.
2. Node runtime: `ScopedHttp` (DNS-pinned) + worker pool + scheduler wiring.
3. Crawler + JS/content/param discovery.
4. Auth multi-identity / role matrix.
5. API/GraphQL → race → business-logic → subdomain-takeover → watch mode.

## Security & performance checklists

**Security:** no direct `node:net`/`fetch` in module code (lint-enforced); `assert` on connect +
each redirect + resolved-IP pin; secret-stripper in `emit`; parsing workers have no network; identity
creds encrypted at rest, redacted from captures/reports; every active run requires a defined scope.

**Performance:** single scheduler (token bucket + semaphore + adaptive 429/403 backoff); frontier /
observation dedup (hashset + bloom at scale); depth/page/time budgets; CPU work in the worker pool;
streamed + batched + incremental graph deltas; keep-alive/H2 pools; size-capped bodies; one
`AbortSignal` threaded scope → collector → scheduler → socket.

## Decision: the ingest-merge model

**Problem.** The enriched graph is (re)built *from captures* via `buildEnrichedGraph` — both the
agent's server-side `GraphStore` and the renderer's `use-security-graph` do this, and rebuild whenever
traffic changes. Collector `Observation`s folded straight into that graph would be **wiped on the next
rebuild**. We need discovered surface to be durable and to survive rebuilds, for both consumers.

**Options considered.**

- **A — Persist observations; fold at build time.** A per-workspace `ObservationStore` (like
  captures/findings). One shared `buildWorkspaceGraph = buildEnrichedGraph(captures)` then
  `foldObservation` for each stored observation. Rebuilds re-apply them. *Pro:* one source of truth,
  rebuild-safe, survives restart, reuses idempotent fold, works for both consumers. *Con:* a new
  persisted store + wiring into both build paths; requires node-id reconciliation.
- **B — In-memory read-time overlay.** Keep folded obs in a separate overlay merged at read.
  *Con:* not durable, dual-graph merge logic everywhere.
- **C — `store.augment()` sticky API.** Store re-applies augmented nodes on rebuild.
  *Con:* not persisted; renderer path still separate; bespoke.

**Decision: Option A.** It matches how every other artifact (captures/findings/canvases) already
works — durable, deterministic, single source of truth — and reuses the idempotent `foldObservation`.

**Critical correctness detail — node-id reconciliation.** A discovered `GET /api/x` MUST collapse
onto the *captured* one. So `foldObservation` generates endpoint/param ids with the SAME
`nodeId`/`edgeId` helpers `buildEnrichedGraph` uses (both exported from `graph/enriched.ts`), not the
ad-hoc `ep:METHOD url` scheme. **Done** — `ingest.ts` now mints `nodeId("Endpoint", url)` (method-
agnostic, matching enriched), keys params `owner?name` (query) / `owner#name` (body), and routes all
edges through `edgeId()`; the discovery-only kinds (Host/Service/Certificate/JsAsset/SecretRef) keep
their own id schemes since they have no captured equivalent. Covered by a collapse test in `ingest.test.ts`.

**Execution steps (next session).**
1. ~~`ingest.ts`: switch endpoint/param/edge ids to enriched `nodeId`/`edgeId` (dedupe discovered ≡ captured).~~ **Done.**
2. ~~New persisted `ObservationStore` (per workspace; SQLite-backed like the others) + `foldObservations(graph, obs[])` helper.~~ **Done** — `ObservationStore` is now part of the `Stores` bundle (in-memory in web-core `stores.ts`, SQLite `observations` table in `capture-store/persisted-stores.ts`), keyed by a content-addressed `observationId` (identity minus the volatile `via.at`) so `put` is idempotent. `foldObservations(graph, obs[], now?)` re-applies a stored set, each at its own discovery time.
3. ~~Server (`mcp-web`): construct the `CollectRuntime` — `createScopeGuard({hosts: scope})`, `createScheduler()`, `createNodeHttp({scope,scheduler})`, `ingest = (o) => observations.put(o)`; `GraphStore` rebuild folds stored observations after `buildEnrichedGraph`.~~ **Done** — `createEnrichedGraphStore(src, observations?)` folds the stored set after `buildEnrichedGraph` + taint; its cache key spans `${captureVersion}#${obs.length}` so a new observation invalidates the cache and re-folds even with no new capture, and `graphVersion` = `captureVersion + obs.length` so clients see a bump on either. `mcp-web` builds the `CollectRuntime` (deny-by-default scope, one scheduler, DNS-pinned `createNodeHttp`) with `ingest = (o) => stores.observations.put(o)` — persist-only; the folded view appears on the next read.
4. ~~Renderer: add `morgana.observations(dir)` IPC; `use-security-graph` folds them post-build (`foldObservation` is pure/browser-safe, so this works client-side).~~ **Done** — `foldObservation`/`foldObservations` + the `Observation` types are now exported from the browser barrel (`@morgana/web-core/graph`). New `morgana-observations` IPC handler reads `stores.observations.list()`; exposed as `window.api.morgana.observations(dir)`. `useSecurityGraph` folds the set after `buildEnrichedGraph`, and the graph page polls it (~4s) and merges it with the throttled capture snapshot so the SPG refolds when either changes — discovered endpoints collapse onto captured nodes by id.
5. Live run: drive `web_crawl` / `web_analyze_js` against an authorized target and confirm discovered
   nodes appear in the graph and survive a capture-triggered rebuild.
   - **Scope is now per-workspace + durable.** A `ScopeStore` (part of `Stores`; SQLite `scope` table)
     holds the engagement's in-scope host globs, set in the desktop **Web → Overview → Scope** panel
     (`morgana-scope-get/set` IPC). mcp-web builds a **dynamic** `ScopeGuard` (`createDynamicScopeGuard`)
     that re-reads the store on every request, so a scope edit takes effect on the next tool call with
     no MCP restart; `MORGANA_SCOPE_HOSTS` remains a CLI/dev fallback. Empty scope ⇒ the collect/recon
     tools refuse with a hint pointing at the panel (deny-by-default egress).
   - **Packaging note:** the desktop spawns the *compiled* `morgana-mcp-web` binary (`app.isPackaged`),
     so changes to `mcp-web`/`capture-store` require a binary rebuild (`bun run prebuild` / any package
     build) to take effect; dev (`bun run dev`) runs the source but needs a full desktop relaunch to
     respawn the MCP. mcp-web startup failures now log to stderr + `<db-dir>/mcp-web-crash.log` (a bare
     "Connection closed" otherwise); driver `busy_timeout` guards the shared-WAL startup race.

Discovered-only nodes (never captured) carry no taint/risk enrichment until exercised — expected;
if later captured they merge by id and gain enrichment.
