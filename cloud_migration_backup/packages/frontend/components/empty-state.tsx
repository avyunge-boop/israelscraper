import { Bus } from "lucide-react"
import type { DashboardUiStrings } from "@/lib/dashboard-i18n"

interface EmptyStateProps {
  ui: DashboardUiStrings
}

export function EmptyState({ ui }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="flex items-center justify-center size-20 rounded-full bg-muted mb-4">
        <Bus className="size-10 text-muted-foreground" />
      </div>
      <h3 className="text-xl font-semibold text-foreground mb-2">{ui.emptyTitle}</h3>
      <p className="text-muted-foreground max-w-sm">{ui.emptyDescription}</p>
    </div>
  )
}
