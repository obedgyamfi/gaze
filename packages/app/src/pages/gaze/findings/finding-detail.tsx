import { For, Show, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { severityMeta, vulnRef, type MorganaFinding } from "./scoring"
import { RiskGauge } from "../viz"

// The vuln outline: the curated, readable write-up for one finding — header with a
// CVSS-band gauge, the agent's description, replay-proven evidence (baseline→test
// diff), and methodology + references for the vuln class (from the shared seed KB).

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-2">
      <span
        class="uppercase"
        style={{ "font-size": "10.5px", "letter-spacing": "0.05em", "font-weight": 500, color: "var(--text-weak)" }}
      >
        {props.title}
      </span>
      {props.children}
    </div>
  )
}

function KV(props: { k: string; children: JSX.Element; mono?: boolean }) {
  return (
    <div class="flex gap-2 text-12-regular">
      <span class="w-16 shrink-0 text-text-weak">{props.k}</span>
      <span class="min-w-0 flex-1 break-words text-text-base" classList={{ "font-mono": props.mono }}>
        {props.children}
      </span>
    </div>
  )
}

function DiffCol(props: { label: string; status: number; length: number; ms: number; accent?: string; delta?: string }) {
  return (
    <div class="flex flex-1 flex-col gap-2 rounded-lg border border-border-weak-base bg-background-base p-3">
      <span
        class="uppercase"
        style={{ "font-size": "10px", "letter-spacing": "0.05em", "font-weight": 500, color: props.accent ?? "var(--text-weak)" }}
      >
        {props.label}
      </span>
      <div class="flex items-baseline gap-2">
        <span class="text-20-medium tabular-nums text-text-strong">{props.status}</span>
        <span class="text-12-regular text-text-weak">status</span>
      </div>
      <div class="flex flex-col gap-0.5 font-mono text-12-regular text-text-base">
        <span>
          {props.length} B
          <Show when={props.delta}>
            <span class="ml-1" style={{ color: props.accent }}>
              {props.delta}
            </span>
          </Show>
        </span>
        <span class="text-text-weak">{props.ms} ms</span>
      </div>
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
    return `Δ${d >= 0 ? "+" : ""}${d}`
  }

  return (
    <div class="flex h-full flex-col gap-6 overflow-y-auto p-5">
      {/* header */}
      <div class="flex items-start gap-4">
        <RiskGauge value={meta().cvss * 10} color={meta().color} size={80} thickness={8} caption="CVSS" />
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <span class="rounded px-2 py-0.5 text-12-medium uppercase text-white" style={{ background: meta().color }}>
              {meta().label}
            </span>
            <span class="text-12-regular text-text-weak">{f().vulnClass}</span>
            <span
              class="rounded border border-border-weak-base px-1.5 py-0.5 uppercase text-text-weak"
              style={{ "font-size": "10.5px", "letter-spacing": "0.03em" }}
            >
              {f().status}
            </span>
          </div>
          <span class="text-16-medium text-text-strong" style={{ "line-height": "1.35" }}>
            {f().title}
          </span>
        </div>
      </div>

      <Section title="Description">
        <p class="whitespace-pre-wrap text-13-regular text-text-base" style={{ "line-height": "var(--line-height-normal)" }}>
          {f().detail}
        </p>
      </Section>

      <Section title="Evidence — replay-proven">
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-1.5 rounded-lg bg-background-stronger p-3">
            <KV k="Oracle">{f().verdict}</KV>
            <KV k="Signal">{f().signal}</KV>
          </div>
          <Show when={f().baseline && f().test}>
            <div class="flex items-stretch gap-2">
              <DiffCol label="Baseline" status={f().baseline!.status} length={f().baseline!.length} ms={f().baseline!.ms} />
              <div class="flex items-center">
                <Icon name="arrow-right" />
              </div>
              <DiffCol
                label="Test"
                status={f().test!.status}
                length={f().test!.length}
                ms={f().test!.ms}
                accent={meta().color}
                delta={lengthDelta()}
              />
            </div>
          </Show>
          <Show when={f().testCaptureId}>
            <KV k="Captures" mono>
              {f().baselineCaptureId ?? "?"} → {f().testCaptureId}
            </KV>
          </Show>
          <Show when={f().nodeId}>
            <KV k="Node" mono>
              {f().nodeId}
            </KV>
          </Show>
        </div>
      </Section>

      <Show when={ref()}>
        {(r) => (
          <Section title="Methodology & references">
            <span class="text-13-medium text-text-strong">{r().title}</span>
            <ol class="flex list-decimal flex-col gap-1 pl-5 text-12-regular text-text-base">
              <For each={r().steps}>{(s) => <li>{s}</li>}</For>
            </ol>
            <Show when={r().refs.length > 0}>
              <div class="flex flex-wrap gap-1.5">
                <For each={r().refs}>
                  {(refId) => (
                    <span class="rounded bg-surface-base px-1.5 py-0.5 font-mono text-12-regular text-text-weak">{refId}</span>
                  )}
                </For>
              </div>
            </Show>
          </Section>
        )}
      </Show>

      <div class="mt-auto border-t border-border-weak-base pt-3 font-mono text-12-regular text-text-weak">
        filed {new Date(f().createdAt).toLocaleString()} · {f().evidenceId}
      </div>
    </div>
  )
}
