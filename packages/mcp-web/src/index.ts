#!/usr/bin/env bun
// ── Morgana `web` MCP server — MCP adapter ────────────────────────────────────
// Thin binding of @morgana/web-core's host-neutral tool specs to an MCP server
// over stdio. Same specs the opencode plugin binds; no tool logic here. For the
// CLI, external MCP clients, and opencode's own MCP-connect flow.
//
// Config via env: MORGANA_CAPTURE_DB (durable captures + persisted findings +
// firing), MORGANA_SCOPE_HOSTS (comma-separated ROE allowlist).

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  ALL_TOOLS,
  createDynamicScopeGuard,
  createEnrichedGraphStore,
  createFetchFire,
  createInMemoryStores,
  createNodeHttp,
  createScheduler,
  createSeedKnowledgeBase,
  type CaptureSource,
  type CollectRuntime,
  type HandlerCtx,
  type Stores,
} from "@morgana/web-core"
import { openBunCaptureStore, openBunStores } from "@morgana/capture-store/bun"
import { workspaceDbPath } from "@morgana/capture-store"

const emptyCaptureSource: CaptureSource = {
  async list() {
    return []
  },
  async getBody() {
    return null
  },
}

export function createServer(opts?: { scopeHosts?: string[]; captureSource?: CaptureSource; stores?: Stores; fire?: HandlerCtx["fire"] }): McpServer {
  const captureSource = opts?.captureSource ?? emptyCaptureSource
  const stores = opts?.stores ?? createInMemoryStores()
  const envScope = opts?.scopeHosts ?? []
  // The engagement scope is read LIVE from the per-workspace store (set in the desktop
  // Web → Scope panel), falling back to the MORGANA_SCOPE_HOSTS env for CLI/dev use. A
  // dynamic ScopeGuard re-reads it on every request, so editing scope in the UI takes
  // effect on the next tool call with no MCP restart. Empty scope ⇒ deny-by-default:
  // the discovery/recon tools refuse (see tools-collect). `ingest` only PERSISTS each
  // observation; it surfaces in the graph on the next read (Option A — rebuild-safe).
  const currentScope = (): string[] => {
    const stored = stores.scope.get()
    return stored.length ? stored : envScope
  }
  const scope = createDynamicScopeGuard(currentScope, true)
  const scheduler = createScheduler()
  const collect: CollectRuntime = {
    scope,
    scheduler,
    net: createNodeHttp({ scope, scheduler }),
    ingest: (o) => stores.observations.put(o),
  }

  const ctx: HandlerCtx = {
    store: createEnrichedGraphStore(captureSource, stores.observations),
    captureSource,
    scopeHosts: currentScope(),
    evidence: stores.evidence,
    findings: stores.findings,
    notes: stores.notes,
    canvases: stores.canvases,
    observations: stores.observations,
    scope: stores.scope,
    kb: createSeedKnowledgeBase(),
    fire: opts?.fire,
    collect,
  }

  const server = new McpServer({ name: "morgana-web", version: "0.0.0" })
  for (const spec of ALL_TOOLS) {
    server.registerTool(
      spec.name,
      {
        description: spec.description,
        // zod-4 raw shape; SDK inputSchema type expects v3-style ZodRawShapeCompat,
        // runtime accepts zod 4 (sdk dep "^3.25 || ^4.0") — cast the type-only mismatch.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        inputSchema: spec.args as any,
        annotations: { readOnlyHint: spec.readOnly, openWorldHint: false },
      },
      async (args: Record<string, unknown>) => {
        const r = await spec.handler(args, ctx)
        return { content: [{ type: "text" as const, text: r.text }], structuredContent: r.data }
      },
    )
  }
  return server
}

async function main(): Promise<void> {
  // Per-WORKSPACE db: opencode spawns a separate mcp-web per project directory with
  // cwd = that directory (InstanceState is per-directory), so resolving the db from
  // cwd scopes each workspace to its own capture/findings data. MORGANA_CAPTURE_DB
  // is an explicit override (testing / non-desktop hosts).
  const dataDir = process.env["MORGANA_DATA_DIR"] ?? process.env["XDG_STATE_HOME"]
  const dbPath = process.env["MORGANA_CAPTURE_DB"] ?? (dataDir ? workspaceDbPath(dataDir, process.cwd()) : undefined)
  const scopeHosts = (process.env["MORGANA_SCOPE_HOSTS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  let server: McpServer
  if (dbPath) {
    const cap = openBunCaptureStore(dbPath)
    server = createServer({ scopeHosts, captureSource: cap, stores: openBunStores(dbPath), fire: createFetchFire({ source: cap, sink: cap, scopeHosts }) })
  } else {
    server = createServer({ scopeHosts })
  }
  await server.connect(new StdioServerTransport())
}

/** Record a fatal startup failure where it can actually be seen. stdout is the JSON-RPC
 *  channel (must stay clean) and opencode pipes but never reads our stderr, so an
 *  uncaught throw here otherwise reaches the client only as an opaque
 *  "-32000: Connection closed". Log to stderr AND a file next to the workspace db. */
function reportFatal(err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
  const line = `[${new Date().toISOString()}] morgana-web fatal startup error (cwd=${process.cwd()}):\n${detail}\n`
  // eslint-disable-next-line no-console
  console.error(line)
  try {
    const dataDir = process.env["MORGANA_DATA_DIR"] ?? process.env["XDG_STATE_HOME"]
    const dbPath = process.env["MORGANA_CAPTURE_DB"] ?? (dataDir ? workspaceDbPath(dataDir, process.cwd()) : undefined)
    if (dbPath) {
      mkdirSync(dirname(dbPath), { recursive: true })
      appendFileSync(join(dirname(dbPath), "mcp-web-crash.log"), line)
    }
  } catch {
    /* best-effort — stderr already has it */
  }
}

// Run as a stdio server when invoked directly. Surface a startup failure instead of
// swallowing it: exit non-zero so the failure is unambiguous, with the reason recorded.
if ((import.meta as { main?: boolean }).main) {
  main().catch((err) => {
    reportFatal(err)
    process.exit(1)
  })
}
