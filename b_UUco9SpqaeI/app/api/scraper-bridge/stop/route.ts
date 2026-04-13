import { NextResponse } from "next/server"

import { getScraperApiBaseUrl } from "@/lib/server/scraper-api"

export const dynamic = "force-dynamic"

export async function POST() {
  const base = getScraperApiBaseUrl()
  if (!base) {
    return NextResponse.json(
      { error: "Remote scraper not configured (SCRAPER_API_URL empty)" },
      { status: 400 }
    )
  }

  try {
    const upstream = await fetch(`${base}/stop-scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
    })
    const text = await upstream.text()
    return new NextResponse(text || '{"ok":true,"stopped":true}', {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("Content-Type") ?? "application/json",
      },
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    )
  }
}
