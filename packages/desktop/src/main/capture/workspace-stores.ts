// ── Per-workspace SQLite stores ───────────────────────────────────────────────
// A workspace = a project directory. Each gets its own capture/findings db at
// <userData>/morgana/<sha1(projectDir)>/captures.db — the SAME path the mcp server
// derives from its cwd (workspaceDbPath), so the agent reads exactly what the
// desktop writes for that workspace. Stores are opened lazily and cached; node:sqlite
// failures degrade to undefined (persistence/reads off, app keeps working).

import { openNodeCaptureStore, openNodeStores } from "@morgana/capture-store/node"
import { workspaceDbPath } from "@morgana/capture-store"

type Caps = ReturnType<typeof openNodeCaptureStore>
type Stores = ReturnType<typeof openNodeStores>

export class WorkspaceStores {
  private readonly capCache = new Map<string, Caps>()
  private readonly storeCache = new Map<string, Stores>()

  constructor(private readonly userData: string) {}

  private path(projectDir: string): string {
    return workspaceDbPath(this.userData, projectDir)
  }

  /** Capture read/write store for a workspace (records, bodies, navs, forms). */
  captures(projectDir: string): Caps | undefined {
    const key = this.path(projectDir)
    let c = this.capCache.get(key)
    if (!c) {
      try {
        c = openNodeCaptureStore(key)
        this.capCache.set(key, c)
      } catch (error) {
        console.error("[morgana] capture store open failed:", error)
        return undefined
      }
    }
    return c
  }

  /** Evidence/findings/notes store for a workspace. */
  findings(projectDir: string): Stores | undefined {
    const key = this.path(projectDir)
    let s = this.storeCache.get(key)
    if (!s) {
      try {
        s = openNodeStores(key)
        this.storeCache.set(key, s)
      } catch (error) {
        console.error("[morgana] findings store open failed:", error)
        return undefined
      }
    }
    return s
  }

  dispose(): void {
    for (const c of this.capCache.values()) {
      try {
        c.close()
      } catch {
        /* ignore */
      }
    }
    this.capCache.clear()
    this.storeCache.clear()
  }
}
