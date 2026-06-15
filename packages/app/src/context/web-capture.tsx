import { createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useLocation } from "@solidjs/router"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { usePlatform } from "@/context/platform"
import type { CaptureRecord, FormRecord, HttpSide, NavRecord, RepeaterRequest } from "@/web/capture-types"

// Renderer-side source of truth for live web capture. Data is partitioned per
// workspace (engagement): records/navs/forms are bucketed by the workspace they
// were captured in, and the selectors expose only the workspace the operator is
// currently viewing — so switching workspaces shows a clean, bounded surface and
// never leaks another engagement's traffic.

interface Bucket {
  records: Record<string, CaptureRecord>
  order: string[]
  navs: NavRecord[]
  forms: FormRecord[]
}

function emptyBucket(): Bucket {
  return { records: {}, order: [], navs: [], forms: [] }
}

// The workspace is the first path segment (the base64 project dir) of routes like
// /:dir/session/:id, where the web-module tools live.
function workspaceOf(pathname: string): string {
  return pathname.split("/").filter(Boolean)[0] ?? "default"
}

export const { use: useWebCapture, provider: WebCaptureProvider } = createSimpleContext({
  name: "WebCapture",
  init: () => {
    const platform = usePlatform()
    const capture = platform.capture
    const location = useLocation()

    const viewWorkspace = createMemo(() => workspaceOf(location.pathname))
    // The workspace a launched browser captures into — set by Overview on launch
    // so streamed traffic is tagged to its engagement even if the operator looks
    // elsewhere mid-capture.
    const [captureWorkspace, setCaptureWorkspace] = createSignal("")
    const targetWorkspace = () => captureWorkspace() || viewWorkspace()

    const [state, setState] = createStore<{ byWs: Record<string, Bucket> }>({ byWs: {} })
    const ensure = (ws: string) => {
      if (!state.byWs[ws]) setState("byWs", ws, emptyBucket())
    }

    const upsert = (record: CaptureRecord) => {
      const ws = targetWorkspace()
      ensure(ws)
      setState(
        "byWs",
        ws,
        produce((b) => {
          if (!(record.id in b.records)) b.order.push(record.id)
          b.records[record.id] = record
        }),
      )
    }

    onMount(() => {
      if (!capture) return
      const unsubscribe = capture.subscribe((event) => {
        switch (event.type) {
          case "record":
            upsert(event.record)
            break
          case "nav": {
            const ws = targetWorkspace()
            ensure(ws)
            setState("byWs", ws, "navs", (n) => [...n, event.nav])
            break
          }
          case "form": {
            const ws = targetWorkspace()
            ensure(ws)
            setState("byWs", ws, "forms", (f) => [...f, event.form])
            break
          }
          case "clear":
            setState("byWs", {})
            break
        }
      })
      onCleanup(unsubscribe)
    })

    const bucket = createMemo(() => state.byWs[viewWorkspace()] ?? emptyBucket())
    const records = createMemo(() =>
      bucket()
        .order.map((id) => bucket().records[id])
        .filter((r): r is CaptureRecord => !!r),
    )

    // Proxy UI state (selection + filters), kept here so it survives the proxy
    // tool tab unmounting on tab switches.
    const [proxyUi, setProxyUi] = createStore({
      selectedId: undefined as string | undefined,
      statusClass: "all" as string,
      query: "",
      starredOnly: false,
    })

    return {
      available: !!capture,
      records,
      navs: () => bucket().navs,
      forms: () => bucket().forms,
      record: (id: string) => bucket().records[id],
      proxyUi,
      setProxyUi,
      /** Tag subsequent capture to a workspace — called by Overview on launch. */
      setCaptureWorkspace: (ws?: string) => setCaptureWorkspace(ws ?? viewWorkspace()),
      getBody: (id: string, side: HttpSide) => capture?.getBody(id, side) ?? Promise.resolve(null),
      // Clear only the workspace currently in view; other engagements are untouched.
      clear: () => setState("byWs", viewWorkspace(), emptyBucket()),
      star: (id: string, on: boolean) => capture?.star(id, on) ?? Promise.resolve(),
      comment: (id: string, text?: string) => capture?.comment(id, text) ?? Promise.resolve(),
      repeaterSend: (req: RepeaterRequest) =>
        capture?.repeaterSend(req) ?? Promise.reject(new Error("capture unavailable")),
    }
  },
})
