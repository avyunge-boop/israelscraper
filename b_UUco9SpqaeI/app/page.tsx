import { Suspense } from "react"
import { TransportDashboard } from "@/components/transport-dashboard"

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="container mx-auto px-4 py-16 text-center text-muted-foreground">
          Loading…
        </div>
      }
    >
      <TransportDashboard />
    </Suspense>
  )
}
