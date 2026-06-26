#!/usr/bin/env bun
import { $ } from "bun"

import { resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../opencode && bun script/build-node.ts`

// Compile the Morgana web-security MCP server into a self-contained binary (bun runtime
// baked in) so the packaged app runs it with no bun/repo on the user's machine.
// electron-builder ships build/bin/ → resources/bin/; server.ts registers it at runtime.
// `--outfile` without an extension lets bun add `.exe` on Windows; server.ts resolves the
// matching per-platform name.
await $`bun build ../mcp-web/src/index.ts --compile --outfile build/bin/morgana-mcp-web`
