import { describe, expect, test } from "bun:test"
import { extractForms, extractLinks, extractScripts } from "./analyze-html.js"

const base = "https://site.test/dir/page"

describe("extractLinks", () => {
  test("resolves relative, drops non-http, dedupes", () => {
    const html = `<a href="/a">a</a><a href="b">b</a><a href="mailto:x@y">m</a><a href="/a#frag">dup</a><a href="https://ext.test/z">e</a>`
    const links = extractLinks(html, base)
    expect(links).toContain("https://site.test/a")
    expect(links).toContain("https://site.test/dir/b")
    expect(links).toContain("https://ext.test/z")
    expect(links.some((l) => l.startsWith("mailto:"))).toBe(false)
    expect(links.filter((l) => l === "https://site.test/a").length).toBe(1)
  })
})

describe("extractForms", () => {
  test("captures method, resolved action, and input names", () => {
    const html = `<form action="/login" method="post"><input name="user"><input name="pass"><select name="role"></select></form>`
    const [f] = extractForms(html, base)
    expect(f.method).toBe("POST")
    expect(f.action).toBe("https://site.test/login")
    expect(f.params.sort()).toEqual(["pass", "role", "user"])
  })
  test("defaults method GET and action to the page", () => {
    const [f] = extractForms(`<form><input name="q"></form>`, base)
    expect(f.method).toBe("GET")
    expect(f.action).toBe(base)
  })
})

describe("extractScripts", () => {
  test("resolves script srcs", () => {
    expect(extractScripts(`<script src="/app.js"></script>`, base)).toContain("https://site.test/app.js")
  })
})
