import { For, Show, type JSX } from "solid-js"
import { severityMeta, vulnRef, type MorganaFinding } from "./scoring"

// The vuln outline: the curated, readable write-up for one finding — header, the
// agent's description, the replay-proven evidence (baseline→test diff), and the
// methodology + references for the vuln class (from the shared seed KB).

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1.5">
      <span class="text-11-medium uppercase tracking-wide text-text-weak">{props.title}</span>
      {props.children}
    </div>
  )
}

function DiffRow(props: { label: string; a: string | number; b: string | number; delta?: string }) {
  return (
    <div class="grid grid-cols-[88px_1fr_1fr] gap-2 px-3 py-1.5 text-12-regular even:bg-surface-base">
      <span class="text-text-weak">{props.label}</span>
      <span class="text-text-base font-mono">{props.a}</span>
      <span class="text-text-base font-mono">
        {props.b}
        <Show when={props.delta}>
          <span class="text-text-weak"> {props.delta}</span>
        </Show>
      </span>
    </div>
  )
}

export function FindingDetail(props: { finding: MorganaFinding }) {
  const f = () => props.finding
  const meta = () => severityMeta(f().severity)
  const ref = () => vulnRef(f().vulnClass)
  const lengthDelta = () => {
    const b = f().baseline
    const t = f().test
    if (!b || !t) return undefined
    const d = t.length - b.length
    return `(Δ${d >= 0 ? "+" : ""}${d}B)`
  }

  return (
    <div class="flex h-full flex-col gap-5 overflow-y-auto p-5">
      <div class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <span class="rounded px-2 py-0.5 text-11-medium uppercase text-white" style={{ background: meta().color }}>
            {meta().label}
          </span>
          <span class="text-12-regular text-text-weak">CVSS ~{meta().cvss.toFixed(1)} · severity-derived</span>
          <span class="text-12-regular text-text-weak">· {f().vulnClass}</span>
          <span class="ml-auto text-11-medium uppercase text-text-weak">{f().status}</span>
        </div>
        <span class="text-16-medium text-text-strong">{f().title}</span>
      </div>

      <Section title="Description">
        <p class="whitespace-pre-wrap text-13-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
          {f().detail}
        </p>
      </Section>

      <Section title="Evidence — replay-proven">
        <div class="flex flex-col gap-1.5 text-12-regular">
          <div class="flex gap-2">
            <span class="text-text-weak">Oracle</span>
            <span class="text-text-base">{f().verdict}</span>
          </div>
          <div class="flex gap-2">
            <span class="shrink-0 text-text-weak">Signal</span>
            <span class="text-text-base">{f().signal}</span>
          </div>
          <Show when={f().baseline && f().test}>
            <div class="mt-1 overflow-hidden rounded-lg border border-border-weak-base">
              <div class="grid grid-cols-[88px_1fr_1fr] gap-2 bg-surface-base px-3 py-1.5 text-11-medium uppercase text-text-weak">
                <span />
                <span>Baseline</span>
                <span>Test</span>
              </div>
              <DiffRow label="Status" a={f().baseline!.status} b={f().test!.status} />
              <DiffRow label="Length" a={`${f().baseline!.length}B`} b={`${f().test!.length}B`} delta={lengthDelta()} />
              <DiffRow label="Time" a={`${f().baseline!.ms}ms`} b={`${f().test!.ms}ms`} />
            </div>
          </Show>
          <Show when={f().testCaptureId}>
            <div class="flex gap-2">
              <span class="shrink-0 text-text-weak">Captures</span>
              <span class="break-all font-mono text-text-base">
                {f().baselineCaptureId ?? "?"} → {f().testCaptureId}
              </span>
            </div>
          </Show>
          <Show when={f().nodeId}>
            <div class="flex gap-2">
              <span class="shrink-0 text-text-weak">Node</span>
              <span class="break-all font-mono text-text-base">{f().nodeId}</span>
            </div>
          </Show>
        </div>
      </Section>

      <Show when={ref()}>
        {(r) => (
          <Section title="Methodology & references">
            <span class="text-13-medium text-text-strong">{r().title}</span>
            <ol class="mt-1 flex list-decimal flex-col gap-1 pl-5 text-12-regular text-text-base">
              <For each={r().steps}>{(s) => <li>{s}</li>}</For>
            </ol>
            <Show when={r().refs.length > 0}>
              <div class="mt-2 flex flex-wrap gap-1.5">
                <For each={r().refs}>
                  {(refId) => (
                    <span class="rounded bg-surface-base px-1.5 py-0.5 font-mono text-11-medium text-text-weak">{refId}</span>
                  )}
                </For>
              </div>
            </Show>
          </Section>
        )}
      </Show>

      <div class="mt-auto font-mono text-11-regular text-text-weak">
        filed {new Date(f().createdAt).toLocaleString()} · {f().evidenceId}
      </div>
    </div>
  )
}
