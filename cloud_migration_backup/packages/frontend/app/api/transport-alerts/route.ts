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

export async function GET() {
  const { alerts, lastUpdated, sourcesUsed } =
    await mergeTransportAlertsFromDisk()

  await applyAlertActivityTimestamps(alerts)

  const structuredById = buildStructuredMapForAlerts(alerts)
  const groqKey = process.env.GROQ_API_KEY?.trim()
  // ממזג לכל התראה aiSummary מ-ai-summaries.json (byId[alert.id] → alert.aiSummary)
  await attachAiSummariesToAlerts(alerts, groqKey, structuredById, {
    generateMissing: false,
    generateEggedMissing: Boolean(groqKey),
  })

  return NextResponse.json({
    alerts,
    meta: {
      lastUpdated,
      count: alerts.length,
      sourcesTried: sourcesUsed.length > 0 ? sourcesUsed : FILE_SPECS.map((s) => s.file),
      aiEnabled: Boolean(groqKey),
    },
  })
}
