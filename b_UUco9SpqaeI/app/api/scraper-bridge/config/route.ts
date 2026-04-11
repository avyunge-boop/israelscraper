import { NextResponse } from "next/server"

import { getScraperApiBaseUrl } from "@/lib/server/scraper-api"

export const dynamic = "force-dynamic"

/** true כשהסריקה רצה מול Cloud Run (לא orchestrator מקומי). */
export function GET() {
  return NextResponse.json({
    useRemoteScraper: Boolean(getScraperApiBaseUrl()),
  })
}
