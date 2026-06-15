import { createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useWebCapture } from "@/context/web-capture"
import type { CaptureRecord } from "@/web/capture-types"
import { buildRawMessage, originOf, parseRawRequest, requestStartLine } from "@/pages/gaze/web/http/raw-http"

// Repeater state — Burp-style editable request tabs. Each tab carries a Target
// (scheme://host) plus the full raw request text being edited; the response is a
// recorded capture. Lives above the tool views so a "send to repeater" survives
// tab switches.

export interface RepeaterTab {
  id: string
  title: string
  /** scheme://host the request is sent to. */
  target: string
  /** Editable raw HTTP request (start line + headers + blank + body). */
  raw: string
  responseId?: string
  sending: boolean
  error?: string
}

let seq = 0

const DEFAULT_RAW = "GET / HTTP/1.1\nHost: \n\n"

export const { use: useRepeater, provider: RepeaterProvider } = createSimpleContext({
  name: "Repeater",
  init: () => {
    const capture = useWebCapture()
    const [store, setStore] = createStore<{ tabs: RepeaterTab[] }>({ tabs: [] })
    const [activeId, setActiveId] = createSignal<string | undefined>()

    const create = (seed?: Partial<RepeaterTab>): string => {
      const id = `rt-${seq++}`
      const tab: RepeaterTab = {
        id,
        title: seed?.title ?? "New request",
        target: seed?.target ?? "",
        raw: seed?.raw ?? DEFAULT_RAW,
        sending: false,
      }
      setStore("tabs", (t) => [...t, tab])
      setActiveId(id)
      return id
    }

    const update = (id: string, patch: Partial<RepeaterTab>) => {
      setStore(
        "tabs",
        (t) => t.id === id,
        produce((t) => Object.assign(t, patch)),
      )
    }

    const close = (id: string) => {
      const idx = store.tabs.findIndex((t) => t.id === id)
      setStore("tabs", (t) => t.filter((x) => x.id !== id))
      if (activeId() === id) setActiveId((store.tabs[idx + 1] ?? store.tabs[idx])?.id)
    }

    const send = async (id: string) => {
      const tab = store.tabs.find((t) => t.id === id)
      if (!tab || tab.sending || !tab.target) return
      update(id, { sending: true, error: undefined })
      try {
        const parsed = parseRawRequest(tab.raw)
        const base = tab.target.replace(/\/$/, "")
        const url = parsed.path.startsWith("http") ? parsed.path : `${base}${parsed.path.startsWith("/") ? "" : "/"}${parsed.path}`
        const record = await capture.repeaterSend({
          method: parsed.method,
          url,
          headers: parsed.headers,
          body: parsed.body,
        })
        update(id, { sending: false, responseId: record.id })
      } catch (err) {
        update(id, { sending: false, error: err instanceof Error ? err.message : String(err) })
      }
    }

    /** Seed a tab from an observed capture (used by proxy + graph). */
    const openFromRecord = async (record: CaptureRecord): Promise<string> => {
      let bodyText: string | undefined
      if (record.requestBody?.present) {
        const b = await capture.getBody(record.id, "request")
        if (b?.text != null) bodyText = b.text
      }
      const raw = buildRawMessage(requestStartLine(record), record.requestHeaders ?? [], bodyText)
      return create({ title: record.path || record.url, target: originOf(record), raw })
    }

    return {
      tabs: () => store.tabs,
      activeId,
      setActive: setActiveId,
      create,
      update,
      close,
      send,
      openFromRecord,
    }
  },
})
