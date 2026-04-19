import { NextResponse } from "next/server"

import { fetchWithRetry } from "@/lib/server/fetch-with-retry"
import { getScraperApiBaseUrl } from "@/lib/server/scraper-api"

export const dynamic = "force-dynamic"

/** Proxies to scraper POST /force-reset-scraper-status (writes scraper-status.json + GCS). */
export async function POST() {
  const base = getScraperApiBaseUrl()
  if (!base) {
    return NextResponse.json(
      { error: "Remote scraper not configured (SCRAPER_API_URL empty)" },
      { status: 400 }
    )
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  const secret = process.env.SCRAPER_FORCE_RESET_SECRET?.trim()
  if (secret) {
    headers.Authorization = `Bearer ${secret}`
  }

  try {
    const upstream = await fetchWithRetry(
      `${base}/force-reset-scraper-status`,
      {
        method: "POST",
        headers,
        body: "{}",
        cache: "no-store",
      },
      { maxRetries: 4 }
    )
    const text = await upstream.text()
    return new NextResponse(text || '{"ok":true}', {
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
