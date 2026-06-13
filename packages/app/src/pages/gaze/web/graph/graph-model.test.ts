import { describe, expect, test } from "bun:test"
import { buildTree, categoryOf, defaultFilters, statusClassColor } from "./graph-model"
import type { CaptureRecord } from "@/web/capture-types"

function rec(partial: Partial<CaptureRecord> & { id: string; url: string }): CaptureRecord {
  return {
    seq: 0,
    source: "browser",
    tsRequest: 0,
    method: "GET",
    host: "",
    path: "",
    scheme: "https",
    requestHeaders: [],
    ...partial,
  } as CaptureRecord
}

describe("categoryOf", () => {
  test("maps resource types and extensions to categories", () => {
    expect(categoryOf({ resourceType: "Document", url: "https://a.test/" })).toBe("page")
    expect(categoryOf({ resourceType: "XHR", url: "https://a.test/api" })).toBe("api")
    expect(categoryOf({ resourceType: "Script", url: "https://a.test/x.js" })).toBe("script")
    expect(categoryOf({ resourceType: "Other", url: "https://a.test/style.css" })).toBe("style")
    expect(categoryOf({ resourceType: "Other", url: "https://a.test/pic.png" })).toBe("image")
    expect(categoryOf({ resourceType: "Other", url: "https://a.test/x", responseBody: { contentType: "application/json" } })).toBe("api")
    expect(categoryOf({ resourceType: "Other", url: "https://a.test/x" })).toBe("other")
  })
})

describe("statusClassColor", () => {
  test("maps status classes", () => {
    expect(statusClassColor(200)).toBe("#10b981")
    expect(statusClassColor(404)).toBe("#fbbf24")
    expect(statusClassColor(undefined)).toBeNull()
  })
})

describe("buildTree", () => {
  test("builds Root → Domain → directories → leaf and compresses single-child chains", () => {
    const tree = buildTree({
      captures: [
        rec({ id: "1", url: "https://app.test/dashboard", resourceType: "Document" }),
        rec({ id: "2", url: "https://app.test/a/b/c", resourceType: "XHR", method: "GET", status: 200 }),
      ],
    })
    const labels = tree.nodes.map((n) => n.label)
    expect(labels).toContain("ATTACK SURFACE")
    expect(labels).toContain("app.test")
    // /a/b single-child chain compresses; the leaf carries /a/b/c
    expect(labels.some((l) => l === "/a/b/c")).toBe(true)
    const leaf = tree.nodes.find((n) => n.label === "/a/b/c")
    expect(leaf?.kind).toBe("leaf")
    expect(leaf?.category).toBe("api")
    expect(leaf?.captureIds).toEqual(["2"])
    expect(leaf?.status).toBe(200)
    // x is column by depth; leaves get distinct rows
    const root = tree.nodes.find((n) => n.kind === "root")!
    expect(root.x).toBe(0)
  })

  test("third-party hosts (never a page) are tagged external", () => {
    const tree = buildTree({
      captures: [
        rec({ id: "1", url: "https://app.test/", resourceType: "Document" }),
        rec({ id: "2", url: "https://cdn.other.test/lib.js", resourceType: "Script" }),
      ],
    })
    const ext = tree.nodes.find((n) => n.host === "cdn.other.test" && n.kind === "leaf")
    expect(ext?.category).toBe("external")
  })

  test("category filters drop leaves and prune empty directories", () => {
    const filters = { ...defaultFilters(), script: false }
    const tree = buildTree({
      captures: [
        rec({ id: "1", url: "https://app.test/", resourceType: "Document" }),
        rec({ id: "2", url: "https://app.test/assets/app.js", resourceType: "Script" }),
      ],
      filters,
    })
    expect(tree.nodes.some((n) => n.label.includes("app.js"))).toBe(false)
    expect(tree.nodes.some((n) => n.label.includes("assets"))).toBe(false)
  })

  test("collapsing a node hides its subtree but keeps a descendant count", () => {
    const collapsed = new Set<string>(["dom:app.test"])
    const tree = buildTree({
      captures: [
        rec({ id: "1", url: "https://app.test/a", resourceType: "Document" }),
        rec({ id: "2", url: "https://app.test/b", resourceType: "Document" }),
      ],
      collapsed,
    })
    const domain = tree.nodes.find((n) => n.id === "dom:app.test")!
    expect(domain.collapsed).toBe(true)
    expect(domain.descCount).toBeGreaterThan(0)
    // children are not emitted while collapsed
    expect(tree.nodes.some((n) => n.label === "/a")).toBe(false)
  })
})
