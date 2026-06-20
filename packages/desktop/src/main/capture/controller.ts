// Capture controller — PER-WORKSPACE. Each workspace (project directory) has its own
// browser (see BrowserController), its own in-memory live store + capture client, and
// its own durable db (via WorkspaceStores). Stream events are tagged with the workspace
// so the renderer buckets them correctly and persistence routes to the right db. No
// global "current workspace" — a capture belongs to the browser it came from.

import type { BrowserController } from "../browser"
import { CaptureClient } from "./client"
import { CaptureStore } from "./store"
import { sendRepeater } from "./repeater"
import { workspaceKey } from "@morgana/capture-store"
import type { WorkspaceStores } from "./workspace-stores"
import type { BodyData, CaptureFilter, CaptureRecord, CaptureStreamEvent, HttpSide, RepeaterRequest } from "./types"

interface Session {
  projectDir: string
  store: CaptureStore // in-memory, for live record assembly (request→response) + immediate UI
  client?: CaptureClient
  activePort?: number
}

type TaggedListener = (projectDir: string, event: CaptureStreamEvent) => void

export class CaptureController {
  private readonly sessions = new Map<string, Session>()
  private readonly listeners = new Set<TaggedListener>()

  constructor(private readonly workspaceStores: WorkspaceStores) {}

  /** Attach a capture client to whichever workspace's browser comes up. */
  attachTo(browser: BrowserController): void {
    browser.onLifecycle((projectDir, status) => {
      if (status.running && status.port) this.startCapture(projectDir, status.port, status.url)
      else this.stopCapture(projectDir)
    })
  }

  private session(projectDir: string): Session {
    const key = workspaceKey(projectDir)
    let s = this.sessions.get(key)
    if (!s) {
      // store emits record/clear; the client emits nav/form — both tagged + broadcast.
      const store = new CaptureStore((event) => this.broadcast(projectDir, event))
      s = { projectDir, store }
      this.sessions.set(key, s)
    }
    return s
  }

  subscribe(listener: TaggedListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // ── workspace-scoped accessors (live in-memory store) ──
  list(projectDir: string, filter?: CaptureFilter): CaptureRecord[] {
    return this.session(projectDir).store.list(filter)
  }
  getBody(projectDir: string, id: string, side: HttpSide): BodyData | undefined {
    return this.session(projectDir).store.getBody(id, side)
  }
  clear(projectDir: string): void {
    this.session(projectDir).store.clear()
  }
  star(projectDir: string, id: string, on: boolean): void {
    this.session(projectDir).store.star(id, on)
  }
  comment(projectDir: string, id: string, text?: string): void {
    this.session(projectDir).store.comment(id, text)
  }
  sendRepeater(projectDir: string, req: RepeaterRequest): Promise<CaptureRecord> {
    return sendRepeater(this.session(projectDir).store, req)
  }

  // ── capture lifecycle ──
  private startCapture(projectDir: string, port: number, navigateTo?: string): void {
    const s = this.session(projectDir)
    if (s.client && s.activePort === port) return
    this.stopSession(s)
    s.activePort = port
    const client = new CaptureClient(s.store, (event) => this.broadcast(projectDir, event))
    s.client = client
    client.start(port, navigateTo).catch(() => {
      if (s.client === client) {
        s.client = undefined
        s.activePort = undefined
      }
    })
  }
  private stopCapture(projectDir: string): void {
    const s = this.sessions.get(workspaceKey(projectDir))
    if (s) this.stopSession(s)
  }
  private stopSession(s: Session): void {
    s.client?.stop()
    s.client = undefined
    s.activePort = undefined
  }

  // ── broadcast + durable persistence (folded in, per workspace) ──
  private broadcast(projectDir: string, event: CaptureStreamEvent): void {
    this.persist(projectDir, event)
    for (const listener of this.listeners) listener(projectDir, event)
  }

  private persist(projectDir: string, event: CaptureStreamEvent): void {
    const store = this.workspaceStores.captures(projectDir)
    if (!store) return
    try {
      switch (event.type) {
        case "record":
          store.putRecord(event.record)
          if (event.record.requestBody?.present) this.persistBody(projectDir, store, event.record.id, "request")
          if (event.record.responseBody?.present) this.persistBody(projectDir, store, event.record.id, "response")
          break
        case "nav":
          store.putNav(event.nav)
          break
        case "form":
          store.putForm(event.form)
          break
        case "clear":
          store.clear()
          break
      }
    } catch {
      // best-effort; never interrupt live capture
    }
  }
  private persistBody(
    projectDir: string,
    store: NonNullable<ReturnType<WorkspaceStores["captures"]>>,
    id: string,
    side: HttpSide,
  ): void {
    const body = this.session(projectDir).store.getBody(id, side)
    if (body?.base64) store.putBody(id, side, Buffer.from(body.base64, "base64"), body.contentType)
  }
}
