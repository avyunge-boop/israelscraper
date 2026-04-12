import { NextResponse } from "next/server"

import { getScraperApiBaseUrl } from "@/lib/server/scraper-api"

export const dynamic = "force-dynamic"

/** Proxy: GET /data/:name על שירות הסקרייפר (מטמון GCS), ללא סריקה חדשה. */
export async function GET(
  _req: Request,
  context: { params: Promise<{ name: string }> }
) {
  const base = getScraperApiBaseUrl()
  if (!base) {
    return NextResponse.json(
      { error: "Remote scraper not configured" },
      { status: 400 }
    )
  }
  const { name } = await context.params
  if (!name || name.includes("..") || name.includes("/")) {
    return NextResponse.json({ error: "invalid name" }, { status: 400 })
  }
  const res = await fetch(`${base}/data/${encodeURIComponent(name)}`, {
    cache: "no-store",
  })
  const text = await res.text()
  return new NextResponse(text, {
    status: res.status,
    headers: {
      "Content-Type":
        res.headers.get("Content-Type") ?? "application/json; charset=utf-8",
    },
  })
}
