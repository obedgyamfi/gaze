import { createMemo, createSignal, For, onMount, Show, type JSX } from "solid-js"
import { useLocation } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { decode64 } from "@/utils/base64"
import { showToast } from "@/utils/toast"
import { buildReportHtml, type ReportMeta } from "./findings/report-html"
import {
  cumulativeSeries,
  riskSummary,
  scoreColor,
  SEVERITY_META,
  severityMeta,
  vulnRef,
  type MorganaFinding,
} from "./findings/scoring"
import { RiskGauge, SeverityDonut, TrendCurve } from "./viz"

// Engagement report: a readable, workspace-scoped write-up of the confirmed findings —
// executive summary with the risk posture, severity breakdown, a discovery timeline,
// findings grouped by severity, and the methodology used. Exportable to markdown/print.

function posture(score: number): { label: string; blurb: string } {
  if (score >= 40)
    return { label: "Critical exposure", blurb: "Severe, exploitable issues were confirmed. Immediate remediation is advised before this surface is exposed further." }
  if (score >= 15)
    return { label: "Elevated risk", blurb: "Meaningful vulnerabilities were confirmed against this target and should be prioritised for remediation." }
  if (score >= 5)
    return { label: "Moderate risk", blurb: "Some issues were confirmed. None are individually critical, but they warrant timely attention." }
  if (score > 0)
    return { label: "Low risk", blurb: "Only low-severity or informational findings were confirmed on this engagement." }
  return { label: "No confirmed findings", blurb: "No vulnerabilities have been confirmed by the oracle yet." }
}

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function Stat(props: { label: string; value: string | number; color?: string }) {
  return (
    <div class="flex flex-col gap-0.5">
      <span class="text-20-medium tabular-nums" style={{ color: props.color }}>
        {props.value}
      </span>
      <span class="uppercase text-text-weak" style={{ "font-size": "10.5px", "letter-spacing": "0.04em" }}>
        {props.label}
      </span>
    </div>
  )
}

function Card(props: { children: JSX.Element; class?: string }) {
  return (
    <div class={`rounded-xl border border-border-weak-base bg-background-stronger p-5 ${props.class ?? ""}`}>
      {props.children}
    </div>
  )
}

const INPUT =
  "h-8 w-full rounded-md border border-border-weak-base bg-surface-base px-2 text-12-regular text-text-base outline-none focus:border-border-strong-base"

function Field(props: { label: string; children: JSX.Element }) {
  return (
    <label class="flex min-w-0 flex-col gap-1">
      <span class="uppercase text-text-weak" style={{ "font-size": "10px", "letter-spacing": "0.04em" }}>
        {props.label}
      </span>
      {props.children}
    </label>
  )
}

const FORMATS: [format: "pdf" | "doc" | "html", label: string][] = [
  ["pdf", "PDF"],
  ["doc", "Word"],
  ["html", "HTML"],
]

const safeName = (s: string) =>
  s.replace(/[^\w.\- ]+/g, "").replace(/\s+/g, " ").trim().replace(/ /g, "_") || "GAZE_Report"

export default function Reports() {
  const location = useLocation()
  const projectDir = () => decode64(location.pathname.split("/").filter(Boolean)[0] ?? "") || ""
  const projectName = () => basename(projectDir()) || "Workspace"

  const [findings, setFindings] = createSignal<MorganaFinding[]>([])
  const [loaded, setLoaded] = createSignal(false)
  const generatedAt = new Date()

  const refresh = async () => {
    const api = window.api?.morgana
    const dir = projectDir()
    if (api && dir) {
      try {
        setFindings(await api.findings(dir))
      } catch {
        /* db not ready */
      }
    }
    setLoaded(true)
  }
  onMount(refresh)

  const summary = createMemo(() => riskSummary(findings()))
  const series = createMemo(() => cumulativeSeries(findings(), 16))
  const grouped = createMemo(() =>
    SEVERITY_META.map((m) => ({
      meta: m,
      items: findings()
        .filter((f) => severityMeta(f.severity).key === m.key)
        .sort((a, b) => b.createdAt - a.createdAt),
    })).filter((g) => g.items.length > 0),
  )
  const methods = createMemo(() =>
    [...new Set(findings().map((f) => f.vulnClass))]
      .map((c) => ({ vulnClass: c, ref: vulnRef(c) }))
      .filter((x): x is { vulnClass: string; ref: NonNullable<ReturnType<typeof vulnRef>> } => Boolean(x.ref)),
  )

  const markdown = () => {
    const s = summary()
    const p = posture(s.score)
    const out: string[] = [
      `# Engagement Report — ${projectName()}`,
      ``,
      `Generated ${generatedAt.toLocaleString()}`,
      ``,
      `## Executive summary`,
      ``,
      `**${p.label}** — risk score ${s.score}/100.`,
      ``,
      `${p.blurb}`,
      ``,
      `| Severity | Count | CVSS band |`,
      `| --- | --- | --- |`,
      ...SEVERITY_META.map((m) => `| ${m.label} | ${s.counts[m.key]} | ~${m.cvss.toFixed(1)} |`),
      ``,
    ]
    for (const g of grouped()) {
      out.push(`## ${g.meta.label} findings (${g.items.length})`, ``)
      for (const f of g.items) {
        out.push(
          `### ${f.title}`,
          ``,
          `- Class: \`${f.vulnClass}\` · Status: ${f.status} · CVSS ~${g.meta.cvss.toFixed(1)}`,
          `- Oracle: ${f.verdict} — ${f.signal}`,
          ...(f.detail ? [``, f.detail] : []),
          ``,
        )
      }
    }
    if (methods().length > 0) {
      out.push(`## Methodology & references`, ``)
      for (const m of methods()) {
        out.push(`### ${m.ref.title}`, ...m.ref.steps.map((s, i) => `${i + 1}. ${s}`), ``, `_Refs: ${m.ref.refs.join(", ")}_`, ``)
      }
    }
    return out.join("\n")
  }

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(markdown())
      showToast({ variant: "success", title: "Report copied", description: "Markdown copied to clipboard." })
    } catch (e) {
      showToast({ variant: "error", title: "Copy failed", description: e instanceof Error ? e.message : String(e) })
    }
  }

  // ── downloadable report (HTML / PDF / Word) ─────────────────────────────────
  const [showDownload, setShowDownload] = createSignal(false)
  const [format, setFormat] = createSignal<"pdf" | "doc" | "html">("pdf")
  const [tester, setTester] = createSignal("")
  const [client, setClient] = createSignal("")
  const [startDate, setStartDate] = createSignal("")
  const [endDate, setEndDate] = createSignal("")
  const [scopeText, setScopeText] = createSignal("")
  const [confidential, setConfidential] = createSignal(true)
  const [saving, setSaving] = createSignal(false)

  const metaKey = () => `gaze-report-meta:${projectDir()}`
  onMount(() => {
    try {
      const raw = localStorage.getItem(metaKey())
      if (!raw) return
      const m = JSON.parse(raw)
      setTester(m.tester ?? "")
      setClient(m.client ?? "")
      setStartDate(m.startDate ?? "")
      setEndDate(m.endDate ?? "")
      setScopeText(m.scopeText ?? "")
      setConfidential(m.confidential ?? true)
    } catch {
      /* ignore malformed */
    }
  })

  const buildMeta = (): ReportMeta => ({
    tester: tester().trim(),
    client: client().trim() || projectName(),
    target: projectName(),
    startDate: startDate() || undefined,
    endDate: endDate() || undefined,
    scope: scopeText().split("\n"),
    confidential: confidential(),
  })

  const download = async () => {
    setSaving(true)
    try {
      const meta = buildMeta()
      const html = buildReportHtml(meta, findings(), new Date())
      localStorage.setItem(
        metaKey(),
        JSON.stringify({
          tester: tester(),
          client: client(),
          startDate: startDate(),
          endDate: endDate(),
          scopeText: scopeText(),
          confidential: confidential(),
        }),
      )
      const base = safeName(`GAZE Report ${meta.client} ${new Date().toISOString().slice(0, 10)}`)
      const api = window.api?.morgana
      if (api?.saveReport) {
        const path = await api.saveReport({ format: format(), html, defaultName: `${base}.${format()}` })
        if (path) {
          showToast({ variant: "success", title: "Report saved", description: path })
          setShowDownload(false)
        }
      } else {
        // web fallback: client-side HTML download only
        const url = URL.createObjectURL(new Blob([html], { type: "text/html" }))
        const a = document.createElement("a")
        a.href = url
        a.download = `${base}.html`
        a.click()
        URL.revokeObjectURL(url)
        setShowDownload(false)
      }
    } catch (e) {
      showToast({ variant: "error", title: "Export failed", description: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="h-full w-full overflow-y-auto bg-background-base">
      <div class="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-8">
        {/* title bar */}
        <header class="flex items-center gap-3">
          <div class="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-base">
            <Icon name="checklist" size="normal" class="text-icon-base" />
          </div>
          <div class="flex min-w-0 flex-col">
            <span class="text-20-medium text-text-strong">Engagement Report</span>
            <span class="truncate text-12-regular text-text-weak">
              {projectName()} · generated {generatedAt.toLocaleDateString()}
            </span>
          </div>
          <Show when={findings().length > 0}>
            <div class="ml-auto flex items-center gap-2">
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-md border border-border-weak-base px-2.5 py-1.5 text-12-medium text-text-base transition-colors hover:bg-surface-base"
                onClick={() => void copyReport()}
              >
                <Icon name="copy" size="small" /> Copy markdown
              </button>
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-md border border-transparent bg-surface-base px-2.5 py-1.5 text-12-medium text-text-strong transition-colors hover:opacity-90"
                onClick={() => setShowDownload(true)}
              >
                <Icon name="download" size="small" /> Download report
              </button>
            </div>
          </Show>
        </header>

        <Show
          when={loaded() ? window.api?.morgana : true}
          fallback={<span class="text-12-regular text-text-weak">Reports are only available in the desktop app.</span>}
        >
          <Show
            when={findings().length > 0}
            fallback={
              <Card class="flex flex-col items-center gap-3 py-16 text-center">
                <div class="grid size-14 place-items-center rounded-2xl bg-surface-base">
                  <Icon name="checklist" size="large" class="text-icon-weak-base" />
                </div>
                <span class="text-13-regular text-text-weak">
                  No findings to report yet — confirmed vulnerabilities appear here as a shareable write-up.
                </span>
              </Card>
            }
          >
            {/* executive summary */}
            <Card>
              <div class="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
                <RiskGauge value={summary().score} color={scoreColor(summary().score)} size={140} caption="RISK" />
                <div class="flex min-w-0 flex-1 flex-col gap-4">
                  <div class="flex flex-col gap-1.5">
                    <span class="text-16-medium" style={{ color: scoreColor(summary().score) }}>
                      {posture(summary().score).label}
                    </span>
                    <p class="text-13-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
                      {posture(summary().score).blurb}
                    </p>
                  </div>
                  <div class="flex flex-wrap gap-8">
                    <Stat label="Findings" value={summary().total} />
                    <Stat
                      label="Critical"
                      value={summary().counts.critical}
                      color={summary().counts.critical > 0 ? "#dc2626" : undefined}
                    />
                    <Stat
                      label="High"
                      value={summary().counts.high}
                      color={summary().counts.high > 0 ? "#ea580c" : undefined}
                    />
                    <Stat label="Confirmed" value={findings().filter((f) => f.status === "confirmed").length} />
                  </div>
                </div>
              </div>
            </Card>

            {/* breakdown + timeline */}
            <div class="grid gap-4 md:grid-cols-2">
              <Card>
                <div class="flex items-center gap-5">
                  <SeverityDonut counts={summary().counts} size={148} />
                  <div class="flex min-w-0 flex-1 flex-col gap-2">
                    <For each={SEVERITY_META}>
                      {(m) => (
                        <div class="flex items-center gap-2 text-12-regular">
                          <span class="size-2 shrink-0 rounded-full" style={{ background: m.color }} />
                          <span class="text-text-base">{m.label}</span>
                          <span class="text-text-weak">~{m.cvss.toFixed(1)}</span>
                          <span class="ml-auto tabular-nums text-text-strong">{summary().counts[m.key]}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Card>

              <Card class="flex flex-col gap-3">
                <span class="uppercase text-text-weak" style={{ "font-size": "10.5px", "letter-spacing": "0.05em" }}>
                  Discovery timeline
                </span>
                <div class="flex flex-1 items-end">
                  <TrendCurve points={series()} color={scoreColor(summary().score)} width={340} height={120} />
                </div>
                <span class="text-12-regular text-text-weak">Cumulative findings over the engagement</span>
              </Card>
            </div>

            {/* findings by severity */}
            <section class="flex flex-col gap-5">
              <For each={grouped()}>
                {(g) => (
                  <div class="flex flex-col gap-2">
                    <div class="flex items-center gap-2">
                      <span class="size-2.5 rounded-full" style={{ background: g.meta.color }} />
                      <span class="text-14-medium text-text-strong">{g.meta.label}</span>
                      <span class="text-12-regular text-text-weak">
                        {g.items.length} · CVSS ~{g.meta.cvss.toFixed(1)}
                      </span>
                    </div>
                    <div class="overflow-hidden rounded-xl border border-border-weak-base">
                      <For each={g.items}>
                        {(f, i) => (
                          <div
                            class="flex flex-col gap-1 bg-background-stronger px-4 py-3"
                            classList={{ "border-t border-border-weak-base": i() > 0 }}
                            style={{ "border-left": `3px solid ${g.meta.color}` }}
                          >
                            <div class="flex items-center gap-2">
                              <span class="min-w-0 flex-1 truncate text-13-medium text-text-strong">{f.title}</span>
                              <span
                                class="shrink-0 rounded border border-border-weak-base px-1.5 py-0.5 uppercase text-text-weak"
                                style={{ "font-size": "10px", "letter-spacing": "0.03em" }}
                              >
                                {f.status}
                              </span>
                            </div>
                            <div class="flex items-center gap-2 text-12-regular text-text-weak">
                              <span>{f.vulnClass}</span>
                              <span class="opacity-50">·</span>
                              <span class="min-w-0 flex-1 truncate">{f.signal}</span>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </section>

            {/* methodology */}
            <Show when={methods().length > 0}>
              <section class="flex flex-col gap-3">
                <span class="uppercase text-text-weak" style={{ "font-size": "10.5px", "letter-spacing": "0.05em" }}>
                  Methodology & references
                </span>
                <div class="flex flex-col gap-4">
                  <For each={methods()}>
                    {(m) => (
                      <Card class="flex flex-col gap-2">
                        <span class="text-13-medium text-text-strong">{m.ref.title}</span>
                        <ol class="flex list-decimal flex-col gap-1 pl-5 text-12-regular text-text-base">
                          <For each={m.ref.steps}>{(s) => <li>{s}</li>}</For>
                        </ol>
                        <Show when={m.ref.refs.length > 0}>
                          <div class="flex flex-wrap gap-1.5">
                            <For each={m.ref.refs}>
                              {(refId) => (
                                <span class="rounded bg-surface-base px-1.5 py-0.5 font-mono text-12-regular text-text-weak">
                                  {refId}
                                </span>
                              )}
                            </For>
                          </div>
                        </Show>
                      </Card>
                    )}
                  </For>
                </div>
              </section>
            </Show>

            <div class="border-t border-border-weak-base pt-4 text-12-regular text-text-weak">
              Generated by the agent's confirmed findings · {generatedAt.toLocaleString()}
            </div>
          </Show>
        </Show>
      </div>

      {/* download modal */}
      <Show when={showDownload()}>
        <div
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setShowDownload(false)}
        >
          <div
            class="flex w-full max-w-md flex-col gap-4 rounded-xl border border-border-weak-base bg-background-stronger p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="flex items-center gap-2">
              <Icon name="download" size="small" class="text-icon-base" />
              <span class="text-14-medium text-text-strong">Download GAZE report</span>
              <button
                class="ml-auto text-text-weak transition-colors hover:text-text-base"
                onClick={() => setShowDownload(false)}
              >
                <Icon name="close-small" size="small" />
              </button>
            </div>

            <div class="flex flex-col gap-1.5">
              <span class="uppercase text-text-weak" style={{ "font-size": "10px", "letter-spacing": "0.04em" }}>
                Format
              </span>
              <div class="grid grid-cols-3 gap-1.5">
                <For each={FORMATS}>
                  {([val, label]) => (
                    <button
                      type="button"
                      onClick={() => setFormat(val)}
                      class="rounded-md border px-2 py-1.5 text-12-medium transition-colors"
                      classList={{
                        "border-transparent bg-surface-base text-text-strong": format() === val,
                        "border-border-weak-base text-text-weak hover:bg-surface-base": format() !== val,
                      }}
                    >
                      {label}
                    </button>
                  )}
                </For>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <Field label="Tester">
                <input value={tester()} onInput={(e) => setTester(e.currentTarget.value)} placeholder="Your name" class={INPUT} />
              </Field>
              <Field label="Client / target">
                <input value={client()} onInput={(e) => setClient(e.currentTarget.value)} placeholder={projectName()} class={INPUT} />
              </Field>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <Field label="Start date">
                <input type="date" value={startDate()} onInput={(e) => setStartDate(e.currentTarget.value)} class={INPUT} />
              </Field>
              <Field label="End date">
                <input type="date" value={endDate()} onInput={(e) => setEndDate(e.currentTarget.value)} class={INPUT} />
              </Field>
            </div>

            <Field label="Scope — one host/URL per line">
              <textarea
                value={scopeText()}
                onInput={(e) => setScopeText(e.currentTarget.value)}
                rows={3}
                placeholder={"https://app.example.com\napi.example.com"}
                class={`${INPUT} h-auto resize-none py-1.5 font-mono`}
              />
            </Field>

            <label class="flex items-center gap-2 text-12-regular text-text-base">
              <input type="checkbox" checked={confidential()} onChange={(e) => setConfidential(e.currentTarget.checked)} />
              Mark as confidential
            </label>

            <div class="flex items-center gap-2 pt-1">
              <span class="text-12-regular text-text-weak">{findings().length} findings</span>
              <button
                class="ml-auto rounded-md px-3 py-1.5 text-12-medium text-text-weak transition-colors hover:text-text-base"
                onClick={() => setShowDownload(false)}
              >
                Cancel
              </button>
              <Button size="small" icon="download" disabled={saving()} onClick={() => void download()}>
                {saving() ? "Saving…" : "Download"}
              </Button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}
