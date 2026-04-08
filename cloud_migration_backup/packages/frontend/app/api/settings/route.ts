import { NextResponse } from "next/server"

import { readAppSettings, writeAppSettings } from "@/lib/server/app-settings"

export const dynamic = "force-dynamic"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function GET() {
  const s = await readAppSettings()
  return NextResponse.json({
    recipientEmail: s.recipientEmail ?? "",
  })
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { recipientEmail?: string }
    const raw = typeof body.recipientEmail === "string" ? body.recipientEmail.trim() : ""
    if (raw && !EMAIL_RE.test(raw)) {
      return NextResponse.json(
        { error: "כתובת אימייל לא תקינה" },
        { status: 400 }
      )
    }
    await writeAppSettings({ recipientEmail: raw || undefined })
    return NextResponse.json({ ok: true, recipientEmail: raw })
  } catch {
    return NextResponse.json({ error: "שגיאת שרת" }, { status: 500 })
  }
}
