import { Tabs } from "@opencode-ai/ui/tabs"
import { GazeViewBody } from "./view"

export const GAZE_TAB_PREFIX = "gaze://"

export const gazeTab = (viewId: string) => `${GAZE_TAB_PREFIX}${viewId}`

export const isGazeTab = (tab: string) => tab.startsWith(GAZE_TAB_PREFIX)

export const gazeTabView = (tab: string) => (isGazeTab(tab) ? tab.slice(GAZE_TAB_PREFIX.length) : undefined)

export function GazeTabContent(props: { tab: string }) {
  return (
    <Tabs.Content value={props.tab} class="relative h-full overflow-hidden">
      <GazeViewBody view={gazeTabView(props.tab) ?? ""} />
    </Tabs.Content>
  )
}
