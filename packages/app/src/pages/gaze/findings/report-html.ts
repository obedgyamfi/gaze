import {
  riskSummary,
  scoreColor,
  SEVERITY_META,
  severityMeta,
  severityRank,
  vulnRef,
  type MorganaFinding,
} from "./scoring"
import { remediationFor } from "./remediation"

// Pure builder: engagement findings → a single standalone, light-theme, print-ready
// HTML document branded as GAZE. Used for the HTML/PDF/Word downloads (PDF/Word are
// rendered from this same HTML in the main process). No external assets — everything
// is inlined so it renders identically offline and in Word/Chromium print.

export interface ReportMeta {
  tester: string
  client: string
  target: string
  startDate?: string
  endDate?: string
  scope: string[]
  confidential: boolean
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

const posture = (score: number) => {
  if (score >= 40) return "Critical exposure"
  if (score >= 15) return "Elevated risk"
  if (score >= 5) return "Moderate risk"
  if (score > 0) return "Low risk"
  return "No confirmed findings"
}

function gaugeSvg(score: number, color: string, size = 148): string {
  const th = 12
  const r = (size - th) / 2
  const c = 2 * Math.PI * r
  const sweep = 0.75
  const cx = size / 2
  const track = `${c * sweep} ${c}`
  const val = `${c * sweep * (Math.min(100, Math.max(0, score)) / 100)} ${c}`
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Risk score ${Math.round(score)}">
  <g transform="rotate(135 ${cx} ${cx})">
    <circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="#e2e8f0" stroke-width="${th}" stroke-dasharray="${track}" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${color}" stroke-width="${th}" stroke-dasharray="${val}" stroke-linecap="round"/>
  </g>
  <text x="${cx}" y="${cx - 2}" text-anchor="middle" dominant-baseline="middle" font-size="${Math.round(size * 0.26)}" font-weight="700" fill="${color}">${Math.round(score)}</text>
  <text x="${cx}" y="${cx + size * 0.17}" text-anchor="middle" font-size="10.5" letter-spacing="1.5" fill="#94a3b8">RISK / 100</text>
</svg>`
}

const EYE = `<svg width="34" height="34" viewBox="0 0 20 20" fill="none"><path d="M10 4.58C5.83 4.58 2.5 10 2.5 10s3.33 5.42 7.5 5.42S17.5 10 17.5 10 14.17 4.58 10 4.58Z" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="10" r="2.5" stroke="currentColor" stroke-width="1.1"/></svg>`

function severityBar(counts: Record<string, number>, total: number): string {
  if (total === 0) return `<div class="dist"><div class="dist-empty"></div></div>`
  const segs = SEVERITY_META.filter((m) => counts[m.key] > 0)
    .map((m) => `<span style="width:${((counts[m.key] / total) * 100).toFixed(2)}%;background:${m.color}"></span>`)
    .join("")
  return `<div class="dist">${segs}</div>`
}

export function buildReportHtml(meta: ReportMeta, findings: MorganaFinding[], generatedAt: Date): string {
  const summary = riskSummary(findings)
  const color = scoreColor(summary.score)
  const ordered = [...findings].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || b.createdAt - a.createdAt,
  )
  const dates =
    meta.startDate && meta.endDate
      ? `${esc(meta.startDate)} – ${esc(meta.endDate)}`
      : meta.startDate
        ? esc(meta.startDate)
        : "—"

  const summaryRows = SEVERITY_META.map(
    (m) => `<tr>
      <td><span class="dot" style="background:${m.color}"></span>${m.label}</td>
      <td class="num">${summary.counts[m.key]}</td>
      <td class="muted">~${m.cvss.toFixed(1)}</td>
    </tr>`,
  ).join("")

  const findingBlocks = ordered
    .map((f, i) => {
      const m = severityMeta(f.severity)
      const rem = remediationFor(f.vulnClass)
      const ref = vulnRef(f.vulnClass)
      const id = `F-${String(i + 1).padStart(2, "0")}`
      const poc =
        f.baseline && f.test
          ? `<table class="poc">
              <thead><tr><th></th><th>Baseline</th><th>Test</th></tr></thead>
              <tbody>
                <tr><td class="muted">Status</td><td>${f.baseline.status}</td><td>${f.test.status}</td></tr>
                <tr><td class="muted">Length</td><td>${f.baseline.length} B</td><td>${f.test.length} B</td></tr>
                <tr><td class="muted">Time</td><td>${f.baseline.ms} ms</td><td>${f.test.ms} ms</td></tr>
              </tbody>
            </table>`
          : ""
      const captures = f.testCaptureId
        ? `<div class="kv"><span>Captures</span><code>${esc(f.baselineCaptureId ?? "?")} &rarr; ${esc(f.testCaptureId)}</code></div>`
        : ""
      const node = f.nodeId ? `<div class="kv"><span>Node</span><code>${esc(f.nodeId)}</code></div>` : ""
      const refs =
        ref && ref.refs.length
          ? `<div class="refs">${ref.refs.map((r) => `<span class="ref">${esc(r)}</span>`).join("")}</div>`
          : ""
      const method = ref
        ? `<div class="sub">Testing method</div><ol class="steps">${ref.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`
        : ""
      return `<section class="finding" style="border-left-color:${m.color}">
        <div class="f-head">
          <span class="fid">${id}</span>
          <span class="badge" style="background:${m.color}">${m.label}</span>
          <span class="cvss">CVSS ~${m.cvss.toFixed(1)}</span>
          <span class="fstatus">${esc(f.status)}</span>
        </div>
        <h3>${esc(f.title)}</h3>
        <div class="meta-line"><code>${esc(f.vulnClass)}</code></div>

        <div class="sub">Description</div>
        <p>${esc(f.detail)}</p>

        <div class="sub">Impact</div>
        <p>${esc(rem.impact)}</p>

        <div class="sub">Proof of concept</div>
        <div class="panel">
          <div class="kv"><span>Oracle</span><span>${esc(f.verdict)}</span></div>
          <div class="kv"><span>Signal</span><span>${esc(f.signal)}</span></div>
          ${captures}
          ${node}
          ${poc}
        </div>

        <div class="sub">Remediation</div>
        <ol class="steps">${rem.remediation.map((r) => `<li>${esc(r)}</li>`).join("")}</ol>
        ${method}
        ${refs}
      </section>`
    })
    .join("")

  const scopeList = meta.scope.filter((s) => s.trim()).length
    ? `<ul class="scope">${meta.scope
        .filter((s) => s.trim())
        .map((s) => `<li><code>${esc(s.trim())}</code></li>`)
        .join("")}</ul>`
    : `<p class="muted">Scope of this assessment: ${esc(meta.target)}.</p>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>GAZE Report — ${esc(meta.client || meta.target)}</title>
<style>
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  :root { --ink:#0f172a; --body:#1e293b; --muted:#64748b; --faint:#94a3b8; --line:#e2e8f0; --panel:#f8fafc; --accent:#4338ca; }
  html,body { margin:0; padding:0; background:#fff; color:var(--body);
    font-family:-apple-system,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif; font-size:13px; line-height:1.55; }
  .page { max-width:820px; margin:0 auto; padding:40px 48px; }
  h1,h2,h3 { color:var(--ink); margin:0; }
  h2 { font-size:17px; margin:0 0 12px; padding-bottom:8px; border-bottom:2px solid var(--line); }
  h3 { font-size:15px; margin:2px 0 6px; }
  p { margin:0 0 10px; }
  code { font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace; font-size:12px; }
  .muted { color:var(--muted); } .num { text-align:right; font-variant-numeric:tabular-nums; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:8px; vertical-align:middle; }

  /* cover */
  .cover { min-height:92vh; display:flex; flex-direction:column; break-after:page; }
  .brand { display:flex; align-items:center; gap:10px; color:var(--accent); font-weight:800; letter-spacing:2px; font-size:22px; }
  .brand .tag { color:var(--faint); font-weight:600; letter-spacing:3px; font-size:10px; }
  .cover-mid { margin-top:auto; margin-bottom:auto; }
  .cover h1 { font-size:34px; line-height:1.15; letter-spacing:-0.5px; }
  .cover .subtitle { color:var(--muted); font-size:15px; margin-top:8px; }
  .cover-meta { margin-top:36px; border-top:1px solid var(--line); padding-top:20px;
    display:grid; grid-template-columns:1fr 1fr; gap:14px 32px; max-width:560px; }
  .cover-meta .k { font-size:10px; letter-spacing:1px; text-transform:uppercase; color:var(--faint); }
  .cover-meta .v { font-size:14px; color:var(--ink); font-weight:600; }
  .confidential { margin-top:auto; padding-top:24px; color:var(--faint); font-size:11px; letter-spacing:0.5px; }

  section.block { padding-top:28px; }
  .exec { display:flex; gap:28px; align-items:center; margin-bottom:18px; }
  .exec .posture { font-size:20px; font-weight:700; }
  .exec .blurb { color:var(--muted); }
  table { border-collapse:collapse; width:100%; }
  .summary td { padding:7px 10px; border-bottom:1px solid var(--line); }
  .summary td:first-child { color:var(--ink); }
  .dist { display:flex; width:100%; height:10px; border-radius:99px; overflow:hidden; background:var(--panel); gap:2px; margin:14px 0 4px; }
  .dist span { display:block; } .dist-empty { width:100%; }

  ul.scope { margin:0; padding-left:18px; } ul.scope li { margin:3px 0; }
  ol.steps { margin:6px 0 10px; padding-left:20px; } ol.steps li { margin:3px 0; }

  section.finding { border:1px solid var(--line); border-left:4px solid; border-radius:10px;
    padding:16px 18px; margin:16px 0; break-inside:avoid; }
  .f-head { display:flex; align-items:center; gap:10px; margin-bottom:2px; }
  .fid { font-family:"SFMono-Regular",Consolas,monospace; font-size:11px; color:var(--faint); }
  .badge { color:#fff; font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; padding:2px 8px; border-radius:5px; }
  .cvss { font-size:11px; color:var(--muted); }
  .fstatus { margin-left:auto; font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:var(--faint); border:1px solid var(--line); padding:2px 7px; border-radius:5px; }
  .meta-line { margin-bottom:10px; }
  .sub { font-size:10px; text-transform:uppercase; letter-spacing:1px; color:var(--faint); font-weight:700; margin:12px 0 5px; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px 14px; }
  .kv { display:flex; gap:12px; margin:2px 0; font-size:12px; }
  .kv > span:first-child { color:var(--muted); min-width:70px; } .kv code { word-break:break-all; }
  table.poc { margin-top:10px; }
  table.poc th { text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:var(--faint); padding:4px 10px; border-bottom:1px solid var(--line); }
  table.poc td { padding:5px 10px; border-bottom:1px solid var(--line); font-family:"SFMono-Regular",Consolas,monospace; font-size:12px; }
  .refs { margin-top:10px; display:flex; flex-wrap:wrap; gap:6px; }
  .ref { background:var(--panel); border:1px solid var(--line); border-radius:5px; padding:2px 7px; font-family:"SFMono-Regular",Consolas,monospace; font-size:11px; color:var(--muted); }

  .footer { margin-top:32px; padding-top:14px; border-top:1px solid var(--line); color:var(--faint); font-size:11px; display:flex; justify-content:space-between; }
  @media print { .page { padding:0 8px; } a { color:inherit; text-decoration:none; } }
</style>
</head>
<body>
<div class="page">

  <div class="cover">
    <div class="brand">${EYE}<span>GAZE</span><span class="tag">SECURITY</span></div>
    <div class="cover-mid">
      <h1>Security Assessment Report</h1>
      <div class="subtitle">${esc(meta.client || meta.target)}</div>
      <div class="cover-meta">
        <div><div class="k">Target</div><div class="v">${esc(meta.target)}</div></div>
        <div><div class="k">Tester</div><div class="v">${esc(meta.tester || "—")}</div></div>
        <div><div class="k">Assessment window</div><div class="v">${dates}</div></div>
        <div><div class="k">Report date</div><div class="v">${esc(generatedAt.toLocaleDateString())}</div></div>
        <div><div class="k">Findings</div><div class="v">${summary.total}</div></div>
        <div><div class="k">Risk score</div><div class="v" style="color:${color}">${summary.score} / 100 · ${posture(summary.score)}</div></div>
      </div>
    </div>
    ${meta.confidential ? `<div class="confidential">CONFIDENTIAL — This document contains sensitive security information intended only for ${esc(meta.client || meta.target)}. Do not distribute.</div>` : ""}
  </div>

  <section class="block">
    <h2>Executive summary</h2>
    <div class="exec">
      ${gaugeSvg(summary.score, color)}
      <div>
        <div class="posture" style="color:${color}">${posture(summary.score)}</div>
        <p class="blurb">This assessment confirmed <strong>${summary.total}</strong> finding${summary.total === 1 ? "" : "s"} against ${esc(meta.target)}, for a weighted risk score of <strong>${summary.score}/100</strong>. Findings below are ordered by severity, each with a proof of concept and remediation guidance.</p>
      </div>
    </div>
    ${severityBar(summary.counts, summary.total)}
    <table class="summary">${summaryRows}</table>
  </section>

  <section class="block">
    <h2>Scope</h2>
    ${scopeList}
  </section>

  <section class="block">
    <h2>Methodology</h2>
    <p>Testing was performed with GAZE, an agent-driven web security platform. Traffic from a controlled browser session was captured and modelled into an attack surface; candidate issues were exercised and every finding in this report was <strong>confirmed by differential replay</strong> — a baseline request and a tampered test request are compared by an oracle, and only oracle-confirmed differences are reported. This favours precision: reported issues are reproducible, not speculative.</p>
  </section>

  <section class="block">
    <h2>Findings</h2>
    ${findingBlocks || `<p class="muted">No confirmed findings.</p>`}
  </section>

  <div class="footer">
    <span>GAZE Security Assessment${meta.confidential ? " · Confidential" : ""}</span>
    <span>Generated ${esc(generatedAt.toLocaleString())}</span>
  </div>

</div>
</body>
</html>`
}
