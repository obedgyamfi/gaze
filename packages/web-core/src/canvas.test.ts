import { describe, expect, test } from "bun:test"
import { applyCanvasPatch, createCanvasRecord } from "./canvas.js"
import { createInMemoryStores } from "./stores.js"
import { CANVAS_TOOLS } from "./tools-canvas.js"
import type { HandlerCtx } from "./tools.js"

const tool = (name: string) => CANVAS_TOOLS.find((t) => t.name === name)!

// canvas tools only touch ctx.canvases — a minimal ctx suffices.
function ctx(): HandlerCtx {
  return { canvases: createInMemoryStores().canvases } as unknown as HandlerCtx
}

describe("createCanvasRecord", () => {
  test("auto-grids nodes that omit coordinates and keeps given ids", () => {
    const rec = createCanvasRecord({
      title: "IDOR chain",
      purpose: "orders",
      nodes: [
        { id: "a", text: "Login" },
        { id: "b", text: "GET /api/orders/{id}", x: 500, y: 40 },
      ],
    })
    const a = rec.canvas.nodes.find((n) => n.id === "a")!
    const b = rec.canvas.nodes.find((n) => n.id === "b")!
    expect(a.type).toBe("text")
    expect(a.width).toBeGreaterThan(0)
    expect(typeof a.x).toBe("number") // auto-positioned
    expect(b.x).toBe(500) // explicit position preserved
  })

  test("drops edges whose endpoints don't exist", () => {
    const rec = createCanvasRecord({
      title: "t",
      nodes: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
      edges: [
        { fromNode: "a", toNode: "b", label: "calls" },
        { fromNode: "a", toNode: "ghost" },
      ],
    })
    expect(rec.canvas.edges.length).toBe(1)
    expect(rec.canvas.edges[0].label).toBe("calls")
  })
})

describe("applyCanvasPatch", () => {
  const base = () =>
    createCanvasRecord({ title: "t", nodes: [{ id: "a", text: "A" }, { id: "b", text: "B" }], edges: [{ fromNode: "a", toNode: "b" }] })

  test("adds, updates, and removes nodes; bumps updatedAt", async () => {
    const rec = base()
    await new Promise((r) => setTimeout(r, 2))
    const next = applyCanvasPatch(rec, {
      addNodes: [{ id: "c", text: "C" }],
      updateNodes: [{ id: "a", text: "A2", color: "#ff0000" }],
      removeNodes: ["b"],
    })
    expect(next.canvas.nodes.map((n) => n.id).sort()).toEqual(["a", "c"])
    expect((next.canvas.nodes.find((n) => n.id === "a") as { text: string }).text).toBe("A2")
    expect(next.updatedAt).toBeGreaterThan(rec.updatedAt)
  })

  test("removing a node prunes its dangling edges", () => {
    const next = applyCanvasPatch(base(), { removeNodes: ["b"] })
    expect(next.canvas.edges.length).toBe(0)
  })
})

describe("canvas tools over the in-memory store", () => {
  test("create → list → read → edit → delete round-trips", async () => {
    const c = ctx()
    const created = await tool("web_canvas_create").handler(
      { title: "Auth flow", purpose: "map", nodes: [{ id: "n1", text: "POST /login" }] },
      c,
    )
    const id = created.data["id"] as string
    expect(id).toBeTruthy()

    const list = await tool("web_canvas_list").handler({}, c)
    expect((list.data["canvases"] as unknown[]).length).toBe(1)

    await tool("web_canvas_edit").handler({ id, add_nodes: [{ id: "n2", text: "Set-Cookie" }], add_edges: [{ from_node: "n1", to_node: "n2", label: "issues" }] }, c)
    const read = await tool("web_canvas_read").handler({ id }, c)
    const canvas = read.data["canvas"] as { nodes: unknown[]; edges: unknown[] }
    expect(canvas.nodes.length).toBe(2)
    expect(canvas.edges.length).toBe(1)

    await tool("web_canvas_delete").handler({ id }, c)
    const after = await tool("web_canvas_list").handler({}, c)
    expect((after.data["canvases"] as unknown[]).length).toBe(0)
  })

  test("read/edit of a missing id returns an error, not a throw", async () => {
    const c = ctx()
    const r = await tool("web_canvas_read").handler({ id: "nope" }, c)
    expect(r.data["error"]).toBeTruthy()
  })
})
