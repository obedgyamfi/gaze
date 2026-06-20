import { createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useLocation } from "@solidjs/router"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { usePlatform } from "@/context/platform"
import { decode64 } from "@/utils/base64"
import type { CaptureRecord, FormRecord, HttpSide, NavRecord, RepeaterRequest } from "@/web/capture-types"

// Renderer-side source of truth for live web capture, partitioned per WORKSPACE
// (project directory). Each workspace has its own browser + db; capture events arrive
// TAGGED with the workspace they belong to (the browser they came from), so switching
// workspaces shows a clean, bounded surface and never leaks another engagement's
// traffic. State is hydrated from each workspace's persisted db on first view.

interface Bucket {
  records: Record<string, CaptureRecord>
  order: string[]
  navs: NavRecord[]
  forms: FormRecord[]
}
function emptyBucket(): Bucket {
  return { records: {}, order: [], navs: [], forms: [] }
}

// The workspace token is the first path segment (base64 project dir) of /:dir/...
function workspaceTokenOf(pathname: string): string {
  return pathname.split("/").filter(Boolean)[0] ?? "default"
}

export const { use: useWebCapture, provider: WebCaptureProvider } = createSimpleContext({
  name: "WebCapture",
  init: () => {
    const platform = usePlatform()
    const capture = platform.capture
    const location = useLocation()

    // The active view's project directory (decoded token) — the bucket key + db key,
    // matching the desktop writer + mcp server.
    const viewDir = createMemo(() => {
      const token = workspaceTokenOf(location.pathname)
      return decode64(token) || token
    })

    const [state, setState] = createStore<{ byDir: Record<string, Bucket> }>({ byDir: {} })
    const ensure = (dir: string) => {
      if (!state.byDir[dir]) setState("byDir", dir, emptyBucket())
    }

    const upsertRecord = (dir: string, record: CaptureRecord) => {
      ensure(dir)
      setState(
        "byDir",
        dir,
        produce((b) => {
          if (!(record.id in b.records)) b.order.push(record.id)
          b.records[record.id] = record
        }),
      )
    }

    // Hydrate a workspace's bucket from its persisted db the first time it's viewed,
    // so graph/proxy show what we left instead of starting empty.
    const hydrated = new Set<string>()
    const hydrate = async (dir: string): Promise<void> => {
      if (!capture || !dir || hydrated.has(dir)) return
      hydrated.add(dir)
      try {
        const data = await capture.load(dir)
        if (!data.records.length && !data.navs.length && !data.forms.length) return
        ensure(dir)
        setState(
          "byDir",
          dir,
          produce((b) => {
            const restored: string[] = []
            for (const r of [...data.records].reverse()) {
              if (!(r.id in b.records)) {
                b.records[r.id] = r
                restored.push(r.id)
              }
            }
            b.order = [...restored, ...b.order]
            b.navs = [...data.navs, ...b.navs]
            b.forms = [...data.forms, ...b.forms]
          }),
        )
      } catch {
        /* persisted load is best-effort */
      }
    }
    createEffect(() => void hydrate(viewDir()))

    onMount(() => {
      if (!capture) return
      const unsubscribe = capture.subscribe((dir, event) => {
        switch (event.type) {
          case "record":
            upsertRecord(dir, event.record)
            break
          case "nav":
            ensure(dir)
            setState("byDir", dir, "navs", (n) => [...n, event.nav])
            break
          case "form":
            ensure(dir)
            setState("byDir", dir, "forms", (f) => [...f, event.form])
            break
          case "clear":
            setState("byDir", dir, emptyBucket())
            break
        }
      })
      onCleanup(unsubscribe)
    })

    const bucket = createMemo(() => state.byDir[viewDir()] ?? emptyBucket())
    const records = createMemo(() =>
      bucket()
        .order.map((id) => bucket().records[id])
        .filter((r): r is CaptureRecord => !!r),
    )

    // Proxy UI state (selection + filters), kept here so it survives the proxy tool
    // tab unmounting on tab switches.
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
      getBody: (id: string, side: HttpSide) => capture?.getBody(id, side, viewDir()) ?? Promise.resolve(null),
      // Clear only the workspace currently in view; other engagements are untouched.
      clear: () => {
        setState("byDir", viewDir(), emptyBucket())
        void capture?.clear(viewDir())
      },
      star: (id: string, on: boolean) => capture?.star(viewDir(), id, on) ?? Promise.resolve(),
      comment: (id: string, text?: string) => capture?.comment(viewDir(), id, text) ?? Promise.resolve(),
      repeaterSend: (req: RepeaterRequest) =>
        capture?.repeaterSend(viewDir(), req) ?? Promise.reject(new Error("capture unavailable")),
    }
  },
})
