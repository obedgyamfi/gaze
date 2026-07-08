import { createUniqueId, For, Show } from "solid-js"
import { SEVERITY_META, type Severity } from "./findings/scoring"

// ── Visualization primitives ──────────────────────────────────────────────────
// Small, dependency-free SVG charts shared across Projects / Findings / Reports.
// Theme-aware (neutral tracks use CSS vars; data colours are passed in), animated,
// and sized by props. No chart library — everything is hand-rolled SVG so it stays
// inside the app's CSP and matches the OpenCode line/curve aesthetic.

const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n))
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)"

/** 270° arc gauge with the value centred — the headline risk meter. */
export function RiskGauge(props: {
  value: number
  color: string
  size?: number
  thickness?: number
  caption?: string
}) {
  const size = () => props.size ?? 132
  const thickness = () => props.thickness ?? 11
  const r = () => (size() - thickness()) / 2
  const circ = () => 2 * Math.PI * r()
  const SWEEP = 0.75 // 270°
  const track = () => `${circ() * SWEEP} ${circ()}`
  const value = () => `${circ() * SWEEP * (clamp(props.value) / 100)} ${circ()}`

  return (
    <div class="relative inline-flex shrink-0" style={{ width: `${size()}px`, height: `${size()}px` }}>
      <svg width={size()} height={size()} viewBox={`0 0 ${size()} ${size()}`} style={{ transform: "rotate(135deg)" }}>
        <circle
          cx={size() / 2}
          cy={size() / 2}
          r={r()}
          fill="none"
          stroke="var(--border-weak-base)"
          stroke-width={thickness()}
          stroke-dasharray={track()}
          stroke-linecap="round"
        />
        <circle
          cx={size() / 2}
          cy={size() / 2}
          r={r()}
          fill="none"
          stroke={props.color}
          stroke-width={thickness()}
          stroke-dasharray={value()}
          stroke-linecap="round"
          style={{ transition: `stroke-dasharray 700ms ${EASE}` }}
        />
      </svg>
      <div class="absolute inset-0 flex flex-col items-center justify-center gap-0.5">
        <span style={{ "font-size": `${Math.round(size() * 0.28)}px`, "font-weight": 600, "line-height": 1, color: props.color }}>
          {Math.round(clamp(props.value))}
        </span>
        <Show when={props.caption}>
          <span class="text-text-weak" style={{ "font-size": "10.5px", "letter-spacing": "0.04em" }}>
            {props.caption}
          </span>
        </Show>
      </div>
    </div>
  )
}

/** Single-value linear meter (compact alternative to the gauge). */
export function LinearMeter(props: { value: number; color: string; height?: number }) {
  return (
    <div
      class="w-full overflow-hidden rounded-full"
      style={{ height: `${props.height ?? 6}px`, background: "var(--surface-base)" }}
    >
      <div
        class="h-full rounded-full"
        style={{ width: `${clamp(props.value)}%`, background: props.color, transition: `width 600ms ${EASE}` }}
      />
    </div>
  )
}

/** Stacked severity-distribution bar — proportion of each severity at a glance. */
export function SeverityBar(props: { counts: Record<Severity, number>; height?: number }) {
  const total = () => SEVERITY_META.reduce((s, m) => s + props.counts[m.key], 0)
  return (
    <div
      class="flex w-full overflow-hidden rounded-full"
      style={{ height: `${props.height ?? 8}px`, background: "var(--surface-base)", gap: "2px" }}
    >
      <Show when={total() > 0}>
        <For each={SEVERITY_META}>
          {(m) => (
            <Show when={props.counts[m.key] > 0}>
              <div
                style={{
                  width: `${(props.counts[m.key] / total()) * 100}%`,
                  background: m.color,
                  transition: `width 600ms ${EASE}`,
                }}
                title={`${m.label}: ${props.counts[m.key]}`}
              />
            </Show>
          )}
        </For>
      </Show>
    </div>
  )
}

// Catmull-Rom → cubic-bezier: a smooth curve through the given points.
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return ""
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`
  let d = `M ${pts[0].x} ${pts[0].y}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)} ${cp2x.toFixed(2)} ${cp2y.toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`
  }
  return d
}

/** Smooth area/line curve — the "trend" graph (e.g. cumulative findings over time). */
export function TrendCurve(props: {
  points: number[]
  color: string
  width?: number
  height?: number
  fill?: boolean
  strokeWidth?: number
}) {
  const w = () => props.width ?? 240
  const h = () => props.height ?? 56
  const id = createUniqueId()
  const PAD = 3

  const coords = () => {
    const pts = props.points
    if (pts.length === 0) return [] as { x: number; y: number }[]
    const min = Math.min(...pts)
    const max = Math.max(...pts)
    const span = max - min || 1
    const usableW = w() - PAD * 2
    const usableH = h() - PAD * 2
    const step = pts.length > 1 ? usableW / (pts.length - 1) : 0
    return pts.map((v, i) => ({
      x: PAD + (pts.length > 1 ? i * step : usableW / 2),
      // flat series sits mid-height; otherwise scale so max is near the top
      y: PAD + (max === min ? usableH / 2 : usableH - ((v - min) / span) * usableH),
    }))
  }

  const line = () => smoothPath(coords())
  const area = () => {
    const c = coords()
    if (c.length < 2) return ""
    return `${line()} L ${c[c.length - 1].x.toFixed(2)} ${h() - PAD} L ${c[0].x.toFixed(2)} ${h() - PAD} Z`
  }

  return (
    <svg width={w()} height={h()} viewBox={`0 0 ${w()} ${h()}`} preserveAspectRatio="none" class="overflow-visible">
      <defs>
        <linearGradient id={`grad-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color={props.color} stop-opacity="0.28" />
          <stop offset="100%" stop-color={props.color} stop-opacity="0" />
        </linearGradient>
      </defs>
      <Show when={coords().length >= 2} fallback={
        <line x1={PAD} y1={h() / 2} x2={w() - PAD} y2={h() / 2} stroke="var(--border-weak-base)" stroke-dasharray="2 3" />
      }>
        <Show when={props.fill !== false}>
          <path d={area()} fill={`url(#grad-${id})`} />
        </Show>
        <path
          d={line()}
          fill="none"
          stroke={props.color}
          stroke-width={props.strokeWidth ?? 2}
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </Show>
    </svg>
  )
}

/** Severity distribution as a donut ring, total in the middle — for Reports. */
export function SeverityDonut(props: {
  counts: Record<Severity, number>
  size?: number
  thickness?: number
}) {
  const size = () => props.size ?? 160
  const thickness = () => props.thickness ?? 16
  const r = () => (size() - thickness()) / 2
  const circ = () => 2 * Math.PI * r()
  const total = () => SEVERITY_META.reduce((s, m) => s + props.counts[m.key], 0)

  const segments = () => {
    const c = circ()
    const t = total()
    if (t === 0) return [] as { color: string; dash: string; offset: number }[]
    let acc = 0
    const out: { color: string; dash: string; offset: number }[] = []
    for (const m of SEVERITY_META) {
      const n = props.counts[m.key]
      if (n === 0) continue
      const frac = n / t
      const len = c * frac
      const gap = Math.min(len, 2) // hairline separation
      out.push({ color: m.color, dash: `${Math.max(0, len - gap)} ${c}`, offset: -acc })
      acc += len
    }
    return out
  }

  return (
    <div class="relative inline-flex shrink-0" style={{ width: `${size()}px`, height: `${size()}px` }}>
      <svg width={size()} height={size()} viewBox={`0 0 ${size()} ${size()}`} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size() / 2} cy={size() / 2} r={r()} fill="none" stroke="var(--surface-base)" stroke-width={thickness()} />
        <For each={segments()}>
          {(seg) => (
            <circle
              cx={size() / 2}
              cy={size() / 2}
              r={r()}
              fill="none"
              stroke={seg.color}
              stroke-width={thickness()}
              stroke-dasharray={seg.dash}
              stroke-dashoffset={seg.offset}
            />
          )}
        </For>
      </svg>
      <div class="absolute inset-0 flex flex-col items-center justify-center gap-0.5">
        <span class="text-20-medium text-text-strong">{total()}</span>
        <span class="text-text-weak" style={{ "font-size": "10.5px", "letter-spacing": "0.04em" }}>
          FINDINGS
        </span>
      </div>
    </div>
  )
}
