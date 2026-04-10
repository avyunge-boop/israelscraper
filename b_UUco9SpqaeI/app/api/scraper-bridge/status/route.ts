import { NextResponse } from "next/server"

import { getScraperApiBaseUrl } from "@/lib/server/scraper-api"

export const dynamic = "force-dynamic"

export async function GET() {
  const base = getScraperApiBaseUrl()
  if (!base) {
    return NextResponse.json({ error: "Remote scraper not configured" }, { status: 400 })
  }
  const res = await fetch(`${base}/status`, { cache: "no-store" })
  const text = await res.text()
  return new NextResponse(text, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "application/json",
    },
  })
}
