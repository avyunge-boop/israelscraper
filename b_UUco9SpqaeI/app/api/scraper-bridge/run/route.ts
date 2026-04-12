import { NextResponse } from "next/server"

import { getScraperApiBaseUrl } from "@/lib/server/scraper-api"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const base = getScraperApiBaseUrl()
  if (!base) {
    return NextResponse.json(
      { error: "Remote scraper not configured (set SCRAPER_API_URL or unset to use default)" },
      { status: 400 }
    )
  }
  let body: unknown = {}
  try {
    body = await request.json()
  } catch {
    /* */
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10_000)

  try {
    const res = await fetch(`${base}/run-scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    const text = await res.text()
    return new NextResponse(text, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("Content-Type") ?? "application/json",
      },
    })
  } catch (err) {
    clearTimeout(timeoutId)
    const e = err instanceof Error ? err : null
    const aborted =
      e?.name === "AbortError" ||
      (typeof e?.message === "string" && /aborted/i.test(e.message))
    if (aborted) {
      return NextResponse.json(
        {
          ok: true,
          started: true,
          note: "Bridge timed out waiting for upstream /run-scrape (10s); scrape may still be running.",
        },
        { status: 200 }
      )
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upstream fetch failed" },
      { status: 502 }
    )
  }
}
