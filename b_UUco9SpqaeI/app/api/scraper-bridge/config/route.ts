import { NextResponse } from "next/server"

import { getScraperApiBaseUrl } from "@/lib/server/scraper-api"

export const dynamic = "force-dynamic"

export function GET() {
  return NextResponse.json({
    useRemoteScraper: Boolean(getScraperApiBaseUrl()),
  })
}
