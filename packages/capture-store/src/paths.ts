// ── Per-workspace db paths ────────────────────────────────────────────────────
// A workspace = a project directory. Its capture/findings db is keyed by a hash of
// the NORMALIZED directory, so the desktop WRITER (knows the dir) and the mcp
// server READER (resolves the dir from process.cwd()) derive the SAME path. Both
// sides must normalize identically — absolute, forward slashes, lowercase (Windows
// is case-insensitive). Pure (node:crypto + node:path) — runs under bun and node.

import { createHash } from "node:crypto"
import { resolve } from "node:path"

export function normalizeDir(projectDir: string): string {
  return resolve(projectDir).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

/** Stable 16-hex key for a workspace directory. */
export function workspaceKey(projectDir: string): string {
  return createHash("sha1").update(normalizeDir(projectDir)).digest("hex").slice(0, 16)
}

/** `<dataDir>/morgana/<workspaceKey>` — the per-workspace data directory. */
export function workspaceDir(dataDir: string, projectDir: string): string {
  return `${dataDir.replace(/\\/g, "/").replace(/\/+$/, "")}/morgana/${workspaceKey(projectDir)}`
}

/** `<workspaceDir>/captures.db` — one capture/findings db per workspace. */
export function workspaceDbPath(dataDir: string, projectDir: string): string {
  return `${workspaceDir(dataDir, projectDir)}/captures.db`
}

/** `<workspaceDir>/browser-profile` — a persistent Chromium profile per workspace,
 *  so an engagement's session/login survives relaunches and never bleeds across
 *  workspaces. */
export function workspaceProfileDir(dataDir: string, projectDir: string): string {
  return `${workspaceDir(dataDir, projectDir)}/browser-profile`
}
