import { createSignal, type JSX } from "solid-js"

// Pointer-capture drag split, horizontal or vertical, used by the proxy and
// repeater. The divider reports a percentage; children fill their side.

export function ResizableSplit(props: {
  direction: "horizontal" | "vertical"
  initial?: number
  min?: number
  max?: number
  first: JSX.Element
  second: JSX.Element
  class?: string
}) {
  const isH = props.direction === "horizontal"
  const [pct, setPct] = createSignal(props.initial ?? 50)
  let root!: HTMLDivElement
  let dragging = false

  const onDown = (e: PointerEvent) => {
    dragging = true
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onMove = (e: PointerEvent) => {
    if (!dragging || !root) return
    const r = root.getBoundingClientRect()
    const p = isH ? ((e.clientX - r.left) / r.width) * 100 : ((e.clientY - r.top) / r.height) * 100
    setPct(Math.min(props.max ?? 85, Math.max(props.min ?? 15, p)))
  }
  const onUp = (e: PointerEvent) => {
    dragging = false
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* noop */
    }
  }

  return (
    <div
      ref={root}
      classList={{ "flex min-h-0 min-w-0": true, "flex-row": isH, "flex-col": !isH, [props.class ?? ""]: !!props.class }}
    >
      <div class="min-h-0 min-w-0 overflow-hidden" style={{ [isH ? "width" : "height"]: `${pct()}%` }}>
        {props.first}
      </div>
      <div
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        title="Drag to resize"
        classList={{
          "shrink-0 bg-border-weak-base transition-colors hover:bg-primary": true,
          "w-px cursor-col-resize hover:w-0.5": isH,
          "h-px cursor-row-resize hover:h-0.5": !isH,
        }}
        style={{ "touch-action": "none" }}
      />
      <div class="min-h-0 min-w-0 flex-1 overflow-hidden">{props.second}</div>
    </div>
  )
}
