import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { access, mkdtemp, rm } from "node:fs/promises"
import { constants } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { app } from "electron"

export type BrowserStatus = {
  running: boolean
  pid?: number
  port?: number
  url?: string
  executable?: string
}

type Listener = (status: BrowserStatus) => void

// Candidate Chromium-family executables per platform, in preference order.
// Chrome first (most common capture target), then Edge (also Chromium), then Chromium.
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

export class BrowserController {
  private child: ChildProcess | undefined
  private profileDir: string | undefined
  private status: BrowserStatus = { running: false }
  private listeners = new Set<Listener>()

  constructor() {
    app.once("will-quit", () => {
      void this.close()
    })
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.status)
    return () => this.listeners.delete(listener)
  }

  getStatus(): BrowserStatus {
    return this.status
  }

  private emit(next: BrowserStatus) {
    this.status = next
    for (const listener of this.listeners) listener(next)
  }

  async launch(opts?: { url?: string }): Promise<BrowserStatus> {
    if (this.child && this.status.running) return this.status

    const executable = await findExecutable()
    if (!executable) {
      throw new Error(
        "No Chromium-based browser found. Install Google Chrome, Microsoft Edge, or Chromium to use the web module.",
      )
    }

    const port = await findFreePort()
    const profileDir = await mkdtemp(join(tmpdir(), "morgana-web-"))
    this.profileDir = profileDir

    const url = opts?.url?.trim() || "about:blank"
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      url,
    ]

    const child = spawn(executable, args, { detached: false, stdio: "ignore" })
    this.child = child

    child.on("exit", () => {
      this.child = undefined
      this.emit({ running: false })
      void this.cleanupProfile()
    })
    child.on("error", () => {
      this.child = undefined
      this.emit({ running: false })
      void this.cleanupProfile()
    })

    const next: BrowserStatus = { running: true, pid: child.pid, port, url, executable }
    this.emit(next)
    return next
  }

  async close(): Promise<void> {
    const child = this.child
    if (!child) return
    this.child = undefined
    try {
      child.kill()
    } catch {
      // already gone
    }
    this.emit({ running: false })
    await this.cleanupProfile()
  }

  private async cleanupProfile() {
    const dir = this.profileDir
    this.profileDir = undefined
    if (!dir) return
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
