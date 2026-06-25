import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { access } from "node:fs/promises"
import { mkdirSync } from "node:fs"
import { constants } from "node:fs"
import { join } from "node:path"
import { app } from "electron"
import { workspaceKey, workspaceProfileDir } from "@morgana/capture-store"

export type BrowserStatus = {
  running: boolean
  pid?: number
  port?: number
  url?: string
  executable?: string
}

type Listener = (status: BrowserStatus) => void
type LifecycleListener = (projectDir: string, status: BrowserStatus) => void

// Candidate Chromium-family executables per platform, in preference order.
function candidateExecutables(): string[] {
  const env = process.env
  if (process.platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean) as string[]
    const rel = [
      ["Google", "Chrome", "Application", "chrome.exe"],
      ["Microsoft", "Edge", "Application", "msedge.exe"],
      ["Chromium", "Application", "chrome.exe"],
    ]
    return roots.flatMap((root) => rel.map((parts) => join(root, ...parts)))
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/microsoft-edge",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ]
}

async function findExecutable(): Promise<string | undefined> {
  for (const candidate of candidateExecutables()) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // try next
    }
  }
  return undefined
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address && typeof address === "object") {
        const { port } = address
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error("could not determine a free port")))
      }
    })
  })
}

interface Instance {
  projectDir: string
  child: ChildProcess | undefined
  status: BrowserStatus
  listeners: Set<Listener>
}

// One Chromium per WORKSPACE (project directory), each with its OWN persistent profile
// so engagement sessions stay isolated and never bleed across workspaces. Spawned
// lazily on launch. The CaptureController subscribes to the lifecycle hook to attach a
// capture client to whichever workspace's browser is up.
export class BrowserController {
  private readonly instances = new Map<string, Instance>()
  private readonly lifecycleListeners = new Set<LifecycleListener>()

  constructor(private readonly userData: string) {
    app.once("will-quit", () => this.closeAll())
  }

  private instance(projectDir: string): Instance {
    const key = workspaceKey(projectDir)
    let i = this.instances.get(key)
    if (!i) {
      i = { projectDir, child: undefined, status: { running: false }, listeners: new Set() }
      this.instances.set(key, i)
    }
    return i
  }

  subscribe(projectDir: string, listener: Listener): () => void {
    const i = this.instance(projectDir)
    i.listeners.add(listener)
    listener(i.status)
    return () => i.listeners.delete(listener)
  }

  getStatus(projectDir: string): BrowserStatus {
    return this.instances.get(workspaceKey(projectDir))?.status ?? { running: false }
  }

  /** Notify the capture layer whenever any workspace's browser starts/stops. */
  onLifecycle(listener: LifecycleListener): () => void {
    this.lifecycleListeners.add(listener)
    return () => this.lifecycleListeners.delete(listener)
  }

  private setStatus(i: Instance, status: BrowserStatus): void {
    i.status = status
    for (const l of i.listeners) l(status)
    for (const l of this.lifecycleListeners) l(i.projectDir, status)
  }

  async launch(projectDir: string, opts?: { url?: string }): Promise<BrowserStatus> {
    const i = this.instance(projectDir)
    if (i.child && i.status.running) return i.status

    const executable = await findExecutable()
    if (!executable) {
      throw new Error(
        "No Chromium-based browser found. Install Google Chrome, Microsoft Edge, or Chromium to use the web module.",
      )
    }

    const port = await findFreePort()
    const profileDir = workspaceProfileDir(this.userData, projectDir)
    mkdirSync(profileDir, { recursive: true })

    const url = opts?.url?.trim() || undefined
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      // NOTE: do NOT add --disable-blink-features=AutomationControlled. navigator.webdriver
      // is already false here (we never pass --enable-automation), so the flag changes
      // nothing — but Chrome shows an "unsupported command-line flag" infobar for it, which
      // is both a UX wart and its own signal. Leaving it off is strictly better.
      "--new-window",
      "about:blank",
    ]

    const child = spawn(executable, args, { detached: false, stdio: "ignore" })
    i.child = child

    child.on("exit", () => {
      i.child = undefined
      this.setStatus(i, { running: false })
    })
    child.on("error", () => {
      i.child = undefined
      this.setStatus(i, { running: false })
    })

    const next: BrowserStatus = { running: true, pid: child.pid, port, url, executable }
    this.setStatus(i, next)
    return next
  }

  async close(projectDir: string): Promise<void> {
    const i = this.instances.get(workspaceKey(projectDir))
    if (!i?.child) return
    const child = i.child
    i.child = undefined
    try {
      child.kill()
    } catch {
      // already gone
    }
    this.setStatus(i, { running: false })
  }

  private closeAll(): void {
    for (const i of this.instances.values()) {
      if (i.child) {
        try {
          i.child.kill()
        } catch {
          // ignore
        }
      }
    }
  }
}
