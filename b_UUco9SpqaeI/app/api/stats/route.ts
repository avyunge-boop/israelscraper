import { NextResponse } from "next/server"

import { computeDashboardStats } from "@/lib/server/stats-engine"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const stats = await computeDashboardStats()
    return NextResponse.json(stats)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
