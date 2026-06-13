import { createMemo, onCleanup, onMount } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { usePlatform } from "@/context/platform"
import type {
  CaptureRecord,
  FormRecord,
  HttpSide,
  NavRecord,
  RepeaterRequest,
} from "@/web/capture-types"

// Renderer-side source of truth for live web capture. Subscribes to the desktop
// capture stream, upserts records by id, and exposes selectors the web-module
// tools (Overview, Graph, Proxy, Repeater) read. One global stream in Phase 1
// (a single launched browser); partitioning per engagement layers on later.

interface CaptureState {
  records: Record<string, CaptureRecord>
  order: string[]
  navs: NavRecord[]
  forms: FormRecord[]
}

export const { use: useWebCapture, provider: WebCaptureProvider } = createSimpleContext({
  name: "WebCapture",
  init: () => {
    const platform = usePlatform()
    const capture = platform.capture

    const [state, setState] = createStore<CaptureState>({
      records: {},
      order: [],
      navs: [],
      forms: [],
    })

    const upsert = (record: CaptureRecord) =>
      setState(
        produce((s) => {
          if (!(record.id in s.records)) s.order.push(record.id)
          s.records[record.id] = record
        }),
      )

    onMount(() => {
      if (!capture) return
      // Capture may have started before this mounted — hydrate the backlog.
      void capture.list().then((rows) => {
        for (const row of [...rows].reverse()) upsert(row)
      })
      const unsubscribe = capture.subscribe((event) => {
        switch (event.type) {
          case "record":
            upsert(event.record)
            break
          case "nav":
            setState("navs", (n) => [...n, event.nav])
            break
          case "form":
            setState("forms", (f) => [...f, event.form])
            break
          case "clear":
            setState({ records: {}, order: [], navs: [], forms: [] })
            break
        }
      })
      onCleanup(unsubscribe)
    })

    const records = createMemo(() =>
      state.order.map((id) => state.records[id]).filter((r): r is CaptureRecord => !!r),
    )

    return {
      available: !!capture,
      records,
      navs: () => state.navs,
      forms: () => state.forms,
      record: (id: string) => state.records[id],
      getBody: (id: string, side: HttpSide) => capture?.getBody(id, side) ?? Promise.resolve(null),
      clear: () => capture?.clear() ?? Promise.resolve(),
      star: (id: string, on: boolean) => capture?.star(id, on) ?? Promise.resolve(),
      comment: (id: string, text?: string) => capture?.comment(id, text) ?? Promise.resolve(),
      repeaterSend: (req: RepeaterRequest) =>
        capture?.repeaterSend(req) ?? Promise.reject(new Error("capture unavailable")),
    }
  },
})
