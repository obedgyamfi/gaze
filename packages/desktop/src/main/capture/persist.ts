// ── Capture persistence — dual-write the live stream to durable SQLite ────────
// The in-memory CaptureStore keeps serving live streaming + the renderer; this
// subscriber additionally writes every record/nav/form to a durable SQLite file
// (node:sqlite, the desktop writer). The opencode sidecar plugin reads the SAME
// file via bun:sqlite (WAL multi-process), so persisting here also bridges the
// captures to the agent — no HTTP ingest route, no server changes.
//
// The db path lives under userData; the sidecar resolves the same path from
// XDG_STATE_HOME (which the desktop sets to userDataPath when spawning it).

import { join } from "node:path"
import { openNodeCaptureStore } from "@morgana/capture-store/node"
import type { CaptureController } from "./controller"
import type { CaptureStreamEvent, HttpSide } from "./types"

export function capturesDbPath(userDataPath: string): string {
  return join(userDataPath, "morgana", "captures.db")
}

/** Subscribe to the controller's stream and mirror it into durable SQLite.
 *  Returns a dispose fn. Persistence failures never break live capture. */
export function attachCapturePersistence(controller: CaptureController, dbPath: string): () => void {
  const store = openNodeCaptureStore(dbPath)

  const persistBody = (id: string, side: HttpSide): void => {
    const body = controller.getBody(id, side)
    if (body?.base64) store.putBody(id, side, Buffer.from(body.base64, "base64"), body.contentType)
  }

  const unsubscribe = controller.subscribe((event: CaptureStreamEvent) => {
    try {
      switch (event.type) {
        case "record":
          store.putRecord(event.record)
          if (event.record.requestBody?.present) persistBody(event.record.id, "request")
          if (event.record.responseBody?.present) persistBody(event.record.id, "response")
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
      // Persistence is best-effort; never let it interrupt live capture. (TODO: log.)
    }
  })

  return () => {
    unsubscribe()
    store.close()
  }
}
