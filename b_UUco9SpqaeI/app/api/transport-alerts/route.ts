import { NextResponse } from "next/server"

import {
  FILE_SPECS,
  mergeTransportAlertsFromDisk,
} from "@/lib/server/merge-transport-alerts"
import {
  attachAiSummariesToAlerts,
  buildStructuredMapForAlerts,
} from "@/lib/server/apply-ai-summaries"
import { applyAlertActivityTimestamps } from "@/lib/server/alert-activity"

export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET(request: Request) {
  const url = new URL(request.url)
  const quick =
    url.searchParams.get("quick") === "1" ||
    url.searchParams.get("quick") === "true"

  const { alerts, lastUpdated, sourcesUsed, scanSourceTimestamps } =
    await mergeTransportAlertsFromDisk()

  if (!quick) {
    await applyAlertActivityTimestamps(alerts)

    const structuredById = buildStructuredMapForAlerts(alerts)
    const groqKey = process.env.GROQ_API_KEY?.trim()
    await attachAiSummariesToAlerts(alerts, groqKey, structuredById, {
      generateMissing: false,
      generateEggedMissing: false,
    })
  }

  const groqKey = process.env.GROQ_API_KEY?.trim()

  return NextResponse.json({
    alerts,
    meta: {
      lastUpdated,
      count: alerts.length,
      sourcesTried: sourcesUsed.length > 0 ? sourcesUsed : FILE_SPECS.map((s) => s.file),
      aiEnabled: Boolean(groqKey),
      quick,
      scanSourceTimestamps: scanSourceTimestamps ?? [],
    },
  })
}
