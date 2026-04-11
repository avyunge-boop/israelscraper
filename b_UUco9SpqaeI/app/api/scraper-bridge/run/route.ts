import { NextResponse } from "next/server"

import { getScraperApiBaseUrl } from "@/lib/server/scraper-api"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const base = getScraperApiBaseUrl()
  if (!base) {
    return NextResponse.json(
      { error: "Remote scraper not configured (SCRAPER_API_URL empty)" },
      { status: 400 }
    )
  }
  let body: unknown = {}
  try {
    body = await request.json()
  } catch {
    /* */
  }
  const res = await fetch(`${base}/run-scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  })
  const text = await res.text()
  return new NextResponse(text, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" },
  })
}
