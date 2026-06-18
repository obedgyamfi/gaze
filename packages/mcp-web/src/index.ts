#!/usr/bin/env bun
import { join } from "node:path"
// ── Morgana `web` MCP server — MCP adapter ────────────────────────────────────
// Thin binding of @morgana/web-core's host-neutral tool specs to an MCP server
// over stdio. Same specs the opencode plugin binds; no tool logic here. For the
// CLI, external MCP clients, and opencode's own MCP-connect flow.
//
// Config via env: MORGANA_CAPTURE_DB (durable captures + persisted findings +
// firing), MORGANA_SCOPE_HOSTS (comma-separated ROE allowlist).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  ALL_TOOLS,
  createEnrichedGraphStore,
  createFetchFire,
  createInMemoryStores,
  createSeedKnowledgeBase,
  type CaptureSource,
  type HandlerCtx,
  type Stores,
} from "@morgana/web-core"
import { openBunCaptureStore, openBunStores } from "@morgana/capture-store/bun"

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
  const ctx: HandlerCtx = {
    store: createEnrichedGraphStore(captureSource),
    captureSource,
    scopeHosts: opts?.scopeHosts ?? [],
    evidence: stores.evidence,
    findings: stores.findings,
    notes: stores.notes,
    kb: createSeedKnowledgeBase(),
    fire: opts?.fire,
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
  const stateHome = process.env["XDG_STATE_HOME"]
  const dbPath = process.env["MORGANA_CAPTURE_DB"] ?? (stateHome ? join(stateHome, "morgana", "captures.db") : undefined)
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

// Run as a stdio server when invoked directly.
if ((import.meta as { main?: boolean }).main) void main()
