import { createSignal } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useCommand, type CommandOption } from "@/context/command"
import { allViews } from "@/modules/registry"
import { useGazeViews } from "@/pages/gaze/open"

export const { use: useGaze, provider: GazeProvider } = createSimpleContext({
    name: "Gaze",
    init: () => {
        const [engagementId, setEngagementId] = createSignal("default")

        const command = useCommand()
        const gaze = useGazeViews()

        command.register("gaze", () => {
            return allViews().map(
                (item): CommandOption => ({
                    id: `gaze.${item.id}.open`,
                    title: `Gaze: Open ${item.label}`,
                    category: "Gaze",
                    onSelect: () => gaze.open(item.id),
                }),
            )
        })

        return { engagementId, setEngagementId }
    }
})
