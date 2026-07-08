import { describe, expect, test } from "bun:test"
import { buildReportHtml, type ReportMeta } from "./report-html"
import type { MorganaFinding } from "./scoring"

const meta: ReportMeta = {
  tester: "Ada Lovelace",
  client: "Acme Corp",
  target: "app.acme.test",
  scope: ["https://app.acme.test", ""],
  confidential: true,
}

const finding = (over: Partial<MorganaFinding> = {}): MorganaFinding => ({
  id: "f1",
  status: "confirmed",
  vulnClass: "idor",
  severity: "high",
  title: "Order access control bypass",
  detail: "Substituting another user's order id returns their order.",
  evidenceId: "e1",
  verdict: "different-owner-200",
  signal: "200 on another owner's id",
  createdAt: Date.now(),
  baseline: { status: 200, ms: 120, length: 512 },
  test: { status: 200, ms: 118, length: 998 },
  baselineCaptureId: "c1",
  testCaptureId: "c2",
  ...over,
})

describe("buildReportHtml", () => {
  const html = buildReportHtml(meta, [finding()], new Date("2026-07-08T12:00:00Z"))

  test("is a standalone GAZE document with the core sections", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true)
    expect(html).toContain("GAZE")
    expect(html).toContain("Security Assessment Report")
    expect(html).toContain("Executive summary")
    expect(html).toContain("Proof of concept")
    expect(html).toContain("Remediation")
    expect(html).toContain("Ada Lovelace")
    expect(html).toContain("Acme Corp")
  })

  test("includes remediation guidance for the finding's vuln class", () => {
    expect(html).toContain("object-level authorization")
  })

  test("escapes untrusted finding text (no raw HTML injection)", () => {
    const evil = buildReportHtml(meta, [finding({ title: "<script>alert(1)</script>" })], new Date())
    expect(evil).not.toContain("<script>alert(1)</script>")
    expect(evil).toContain("&lt;script&gt;")
  })

  test("empty findings still renders a valid report", () => {
    const empty = buildReportHtml(meta, [], new Date())
    expect(empty).toContain("No confirmed findings")
  })
})
