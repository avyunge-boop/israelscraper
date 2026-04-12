import { NextResponse } from "next/server"

import { getScraperApiBaseUrl } from "@/lib/server/scraper-api"

export const dynamic = "force-dynamic"

/** פרוקסי SSE ל־Cloud Run: `POST .../run-scrape?stream=1` עם אותו גוף כמו `/run-scrape`. */
export async function POST(request: Request) {
  const base = getScraperApiBaseUrl()
  if (!base) {
    return NextResponse.json(
      { error: "Remote scraper not configured (SCRAPER_API_URL empty)" },
      { status: 400 }
    )
  }
  const bodyText = await request.text()
  const upstream = await fetch(`${base}/run-scrape?stream=1`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: bodyText || "{}",
    cache: "no-store",
  })
  if (!upstream.ok) {
    const t = await upstream.text()
    return new NextResponse(t, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("Content-Type") ?? "application/json",
      },
    })
  }
  if (!upstream.body) {
    return NextResponse.json(
      { error: "Upstream returned empty body" },
      { status: 502 }
    )
  }
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}
