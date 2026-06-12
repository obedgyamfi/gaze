import { useGaze } from "@/context/gaze"

export default function GazeNotes() {
    const gaze = useGaze() 
    return (
        <div class="h-full w-full flex flex-col items-center justify-center gap-2 bg-background-base">
            <span class="text-14-regular text-text-strong">Notes</span>
            <span class="text-12-regular text-text-weak">engagement: {gaze.engagementId()}</span>
        </div>
    )
}