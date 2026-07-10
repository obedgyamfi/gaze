// ── Proxy controller — PER-WORKSPACE intercepting proxy ───────────────────────
// Mirrors BrowserController: each workspace can run its own MITM proxy (its own port),
// and every intercepted transaction is fed into that workspace's capture pipeline as a
// `proxy`-source record — so emulator/device traffic populates the same attack-surface
// graph as the built-in browser. One shared CA (Burp-style) is generated lazily on first
// start and installed by the user on the device.

import { workspaceKey } from "@morgana/capture-store"
import { CertAuthority } from "./ca.js"
import { MitmProxy, type ProxyRequestEvent, type ProxyResponseEvent } from "./mitm.js"

export interface ProxyStatus {
  running: boolean
  host?: string
  port?: number
  error?: string
}

/** Where intercepted transactions go — the desktop wires this to the CaptureController. */
export interface ProxyCaptureSink {
  onRequest(projectDir: string, ev: ProxyRequestEvent): void
  onResponse(projectDir: string, ev: ProxyResponseEvent): void
}

type StatusListener = (projectDir: string, status: ProxyStatus) => void

const DEFAULT_HOST = "0.0.0.0" // bind all interfaces so an emulator on the LAN can reach it
const DEFAULT_PORT = 8080

export class ProxyController {
  private ca?: CertAuthority
  private readonly servers = new Map<string, { proxy: MitmProxy; status: ProxyStatus }>()
  private readonly listeners = new Set<StatusListener>()

  constructor(
    private readonly caDir: string,
    private readonly sink: ProxyCaptureSink,
  ) {}

  // CA generation does RSA keygen (~0.5s) — defer it until the proxy is actually used.
  private authority(): CertAuthority {
    if (!this.ca) this.ca = CertAuthority.load(this.caDir)
    return this.ca
  }

  /** The CA certificate (PEM) to install on the emulator/device. Generates the CA if needed. */
  caCertPem(): string {
    return this.authority().caCertPem()
  }

  status(projectDir: string): ProxyStatus {
    if (!projectDir) return { running: false }
    return this.servers.get(workspaceKey(projectDir))?.status ?? { running: false }
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private emit(projectDir: string, status: ProxyStatus): void {
    for (const l of this.listeners) l(projectDir, status)
  }

  async start(projectDir: string, opts?: { host?: string; port?: number }): Promise<ProxyStatus> {
    if (!projectDir) return { running: false, error: "no workspace open" }
    const key = workspaceKey(projectDir)
    const existing = this.servers.get(key)
    if (existing?.status.running) return existing.status

    const host = opts?.host || DEFAULT_HOST
    const port = opts?.port || DEFAULT_PORT
    const proxy = new MitmProxy({
      ca: this.authority(),
      sink: {
        onRequest: (ev) => this.sink.onRequest(projectDir, ev),
        onResponse: (ev) => this.sink.onResponse(projectDir, ev),
      },
    })
    try {
      await proxy.listen(host, port)
    } catch (e) {
      const status: ProxyStatus = { running: false, host, port, error: e instanceof Error ? e.message : String(e) }
      this.emit(projectDir, status)
      return status
    }
    const status: ProxyStatus = { running: true, host, port }
    this.servers.set(key, { proxy, status })
    this.emit(projectDir, status)
    return status
  }

  async stop(projectDir: string): Promise<void> {
    const s = this.servers.get(workspaceKey(projectDir))
    if (!s) return
    await s.proxy.close()
    this.servers.delete(workspaceKey(projectDir))
    this.emit(projectDir, { running: false })
  }

  async dispose(): Promise<void> {
    for (const s of this.servers.values()) {
      try {
        await s.proxy.close()
      } catch {
        /* ignore */
      }
    }
    this.servers.clear()
  }
}
