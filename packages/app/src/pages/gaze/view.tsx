import { lazy, type Component } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useParams } from "@solidjs/router"
import { allViews, findView } from "@/modules/registry"

const LAZY: Record<string, Component> = Object.fromEntries(
  allViews()
    .filter((view) => view.component)
    .map((view) => [view.id, lazy(view.component!)]),
)

function Stub(props: { view: string }) {
  const label = () => findView(props.view)?.label ?? props.view
  return (
    <div class="h-full w-full flex flex-col items-center justify-center gap-2 bg-background-base">
      <span class="text-14-regular text-text-strong">{label()}</span>
      <span class="text-12-regular text-text-weak">coming soon</span>
    </div>
  )
}

export function GazeViewBody(props: { view: string }) {
  const resolved = () => LAZY[props.view] ?? (() => <Stub view={props.view} />)
  return <Dynamic component={resolved()} />
}

export default function GazeView() {
  const params = useParams<{ view: string }>()
  return <GazeViewBody view={params.view} />
}
