// Capture controller — single owner of the store + CDP client. Starts capture
// when the operator's browser comes up (driven off BrowserController status) and
// stops it when the browser closes. The IPC layer subscribes here to stream
// events to the renderer and to serve body/list/repeater requests.

import type { BrowserController } from "../browser"
import { CaptureClient } from "./client"
import { CaptureStore } from "./store"
import { sendRepeater } from "./repeater"
import type {
  BodyData,
  CaptureFilter,
  CaptureRecord,
  CaptureStreamEvent,
  HttpSide,
  RepeaterRequest,
} from "./types"

export class CaptureController {
  private store: CaptureStore
  private client: CaptureClient | undefined
  private activePort: number | undefined
  private listeners = new Set<(event: CaptureStreamEvent) => void>()

  constructor() {
    this.store = new CaptureStore((event) => this.broadcast(event))
  }

  /** React to browser lifecycle: start capture on launch, stop on close. */
  attachTo(browser: BrowserController): void {
    browser.subscribe((status) => {
      if (status.running && status.port) this.startCapture(status.port, status.url)
      else this.stopCapture()
    })
  }

  subscribe(listener: (event: CaptureStreamEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(filter?: CaptureFilter): CaptureRecord[] {
    return this.store.list(filter)
  }

  getBody(id: string, side: HttpSide): BodyData | undefined {
    return this.store.getBody(id, side)
  }

  clear(): void {
    this.store.clear()
  }

  star(id: string, on: boolean): void {
    this.store.star(id, on)
  }

  comment(id: string, text?: string): void {
    this.store.comment(id, text)
  }

  sendRepeater(req: RepeaterRequest): Promise<CaptureRecord> {
    return sendRepeater(this.store, req)
  }

  private startCapture(port: number, navigateTo?: string): void {
    if (this.client && this.activePort === port) return
    this.stopCapture()
    this.activePort = port
    const client = new CaptureClient(this.store, (event) => this.broadcast(event))
    this.client = client
    client.start(port, navigateTo).catch(() => {
      if (this.client === client) {
        this.client = undefined
        this.activePort = undefined
      }
    })
  }

  private stopCapture(): void {
    this.client?.stop()
    this.client = undefined
    this.activePort = undefined
  }

  private broadcast(event: CaptureStreamEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
