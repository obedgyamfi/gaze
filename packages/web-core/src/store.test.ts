import { describe, expect, test } from "bun:test"
import { createEnrichedGraphStore } from "./store.js"
import { nodeId } from "./graph/enriched.js"
import { createInMemoryStores } from "./stores.js"
import type { CaptureRecord, CaptureSource } from "./capture-source.js"

// A minimal in-memory CaptureSource whose version bumps whenever the record set grows,
// so we can exercise the store's rebuild path deterministically.
function fakeSource(records: CaptureRecord[]): CaptureSource & { add(r: CaptureRecord): void } {
  const list = [...records]
  return {
    add: (r) => void list.push(r),
    async list() {
      return list
    },
    async getBody() {
      return null
    },
    async version() {
      return list.length
    },
  }
}

function capture(id: string, url: string): CaptureRecord {
  const u = new URL(url)
  return {
    id,
    seq: Number(id.replace(/\D/g, "")) || 0,
    source: "browser",
    tsRequest: 1,
    method: "GET",
    url,
    host: u.hostname,
    path: u.pathname,
    scheme: u.protocol.replace(":", ""),
    resourceType: "XHR",
    requestHeaders: [],
    status: 200,
  }
}

describe("createEnrichedGraphStore with observations", () => {
  test("discovered observations appear in the graph via search", async () => {
    const src = fakeSource([])
    const { observations } = createInMemoryStores()
    observations.put({ kind: "endpoint", method: "GET", url: "https://a.test/api/hidden", via: { collector: "crawler", at: 1 } })
    const store = createEnrichedGraphStore(src, observations)

    const page = await store.search({ kinds: ["Endpoint"] })
    expect(page.items.some((n) => n.url === "https://a.test/api/hidden")).toBe(true)
  })

  test("discovered nodes survive a capture-triggered rebuild (Option A durability)", async () => {
    const src = fakeSource([])
    const { observations } = createInMemoryStores()
    observations.put({ kind: "endpoint", method: "GET", url: "https://a.test/api/hidden", via: { collector: "crawler", at: 1 } })
    const store = createEnrichedGraphStore(src, observations)

    // First read builds + folds.
    await store.overview({})
    // A new capture arrives → version bumps → the store rebuilds from captures. The
    // discovered node must still be present (re-folded), not wiped by the rebuild.
    src.add(capture("c1", "https://a.test/"))
    const { nodes } = await store.nodes({ ids: [nodeId("Endpoint", "https://a.test/api/hidden")] })
    expect(nodes.length).toBe(1)
  })

  test("a discovered endpoint collapses onto the captured node (no parallel node)", async () => {
    const src = fakeSource([capture("c1", "https://a.test/api/x")])
    const { observations } = createInMemoryStores()
    // Same URL as the capture — must merge onto the one node, not fork a second.
    observations.put({ kind: "endpoint", method: "GET", url: "https://a.test/api/x", via: { collector: "js", at: 1 } })
    const store = createEnrichedGraphStore(src, observations)

    const page = await store.search({ q: "/api/x" })
    const matches = page.items.filter((n) => n.url === "https://a.test/api/x")
    expect(matches.length).toBe(1)
  })

  test("graphVersion bumps when an observation is added without any new capture", async () => {
    const src = fakeSource([capture("c1", "https://a.test/")])
    const { observations } = createInMemoryStores()
    const store = createEnrichedGraphStore(src, observations)

    const before = (await store.overview({})).graphVersion
    observations.put({ kind: "endpoint", method: "GET", url: "https://a.test/new", via: { collector: "crawler", at: 1 } })
    const after = (await store.overview({})).graphVersion
    expect(after).toBeGreaterThan(before)
  })
})
