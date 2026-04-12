import nodemailer from "nodemailer"
import { NextResponse } from "next/server"

import { sanitizeAiSummaryOutput } from "@/lib/ai-summary-sanitize"
import type { AlertProvider, TransportAlert } from "@/lib/transport-alert"
import {
  attachAiSummariesToAlerts,
  buildStructuredMapForAlerts,
} from "@/lib/server/apply-ai-summaries"
import { readAppSettings } from "@/lib/server/app-settings"
import { mergeTransportAlertsFromDisk } from "@/lib/server/merge-transport-alerts"

export const dynamic = "force-dynamic"
export const maxDuration = 120

type FilterPayload =
  | "all"
  | "busnearby"
  | AlertProvider

function filterAlerts(
  alerts: TransportAlert[],
  filter: FilterPayload
): TransportAlert[] {
  if (filter === "all") return alerts
  if (filter === "busnearby") return alerts.filter((a) => a.dataSource === "busnearby")
  return alerts.filter((a) => a.provider === filter)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function agencyLabelForAlert(a: TransportAlert): string {
  const g = (a.agencyGroupLabel ?? "").trim()
  if (g) return g
  return a.provider || "אחר"
}

function groupKeyForAlert(a: TransportAlert): string {
  return agencyLabelForAlert(a)
}

function fullDescriptionCell(a: TransportAlert): string {
  const raw = [a.title, a.fullContent].filter(Boolean).join("\n\n").trim()
  const max = 6000
  const t = raw.length > max ? `${raw.slice(0, max)}…` : raw
  return t || "—"
}

function aiSummaryCell(a: TransportAlert): string {
  const s = sanitizeAiSummaryOutput(a.aiSummary ?? "").trim()
  if (s) return s
  return "מעבד סיכום..."
}

function buildHtmlEmail(slice: TransportAlert[], filter: FilterPayload): string {
  const title =
    filter === "all"
      ? "דוח התראות תחבורה (הכל)"
      : filter === "busnearby"
        ? "דוח Bus Nearby"
        : `דוח התראות — ${filter}`

  const groups = new Map<string, TransportAlert[]>()
  for (const a of slice) {
    const k = groupKeyForAlert(a)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(a)
  }
  const sortedKeys = [...groups.keys()].sort((a, b) =>
    a.localeCompare(b, "he", { sensitivity: "base" })
  )

  const th =
    "background-color:#e8e8e8;border:1px solid #bfbfbf;padding:10px 12px;text-align:right;font-weight:600;font-size:14px;"
  const td =
    "border:1px solid #bfbfbf;padding:8px 12px;text-align:right;vertical-align:top;font-size:14px;line-height:1.45;word-break:break-word;"
  const table =
    "border-collapse:collapse;table-layout:auto;width:100%;max-width:960px;margin:0 0 28px 0;direction:rtl;"

  const sections = sortedKeys
    .map((groupName) => {
      const list = groups.get(groupName) ?? []
      const bodyRows = list
        .map((a) => {
          const agency = escapeHtml(agencyLabelForAlert(a))
          const line = escapeHtml(a.lineNumbers.join(", ") || "—")
          const desc = escapeHtml(fullDescriptionCell(a))
          const summary = escapeHtml(aiSummaryCell(a))
          const linkText =
            a.link.length > 48 ? `${escapeHtml(a.link.slice(0, 45))}…` : escapeHtml(a.link)
          return `<tr>
<td style="${td}">${agency}</td>
<td style="${td}">${line}</td>
<td style="${td}">${desc}</td>
<td style="${td}">${summary}</td>
<td style="${td}"><a href="${escapeHtml(a.link)}" style="color:#0b57d0;text-decoration:underline;">${linkText}</a></td>
</tr>`
        })
        .join("\n")

      return `<h3 style="margin:24px 0 10px;font-size:17px;font-weight:600;">${escapeHtml(groupName)}</h3>
<table role="presentation" cellpadding="0" cellspacing="0" style="${table}">
<thead><tr>
<th style="${th}">סוכנות</th>
<th style="${th}">קו</th>
<th style="${th}">תוכן מלא</th>
<th style="${th}">סיכום AI</th>
<th style="${th}">קישור</th>
</tr></thead>
<tbody>${bodyRows}</tbody>
</table>`
    })
    .join("\n")

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:16px;font-family:Arial,Helvetica,sans-serif;direction:rtl;text-align:right;background:#fafafa;color:#222;">
<div style="max-width:980px;margin:0 auto;background:#fff;padding:20px 24px;border:1px solid #e0e0e0;">
<h2 style="margin:0 0 8px;font-size:20px;">${escapeHtml(title)}</h2>
<p style="margin:0 0 16px;color:#555;font-size:14px;">סה״כ ${slice.length} התראות</p>
${sections}
</div>
</body>
</html>`
}

export async function POST(request: Request) {
  const host = process.env.BUS_ALERTS_SMTP_HOST?.trim()
  const from = process.env.BUS_ALERTS_EMAIL_FROM?.trim()
  const envTo = process.env.BUS_ALERTS_EMAIL_TO?.trim()
  const isLocalDev = process.env.NODE_ENV === "development"

  let filter: FilterPayload = "all"
  let bodyTo: string | undefined
  try {
    const b = (await request.json()) as {
      filter?: FilterPayload
      to?: string
    }
    if (b?.filter) filter = b.filter
    if (typeof b?.to === "string") bodyTo = b.to.trim() || undefined
  } catch {
    /* גוף ריק */
  }

  if (!host || !from) {
    if (isLocalDev) {
      return NextResponse.json({
        ok: true,
        sent: 0,
        emailSkipped: true,
        skipReason: "smtp_not_configured",
        filter,
      })
    }
    return NextResponse.json(
      {
        error:
          "SMTP לא מוגדר: נדרשים BUS_ALERTS_SMTP_HOST ו-BUS_ALERTS_EMAIL_FROM ב-.env",
      },
      { status: 503 }
    )
  }

  const settings = await readAppSettings()
  const recipient = bodyTo || settings.recipientEmail || envTo
  if (!recipient) {
    return NextResponse.json(
      {
        error:
          "אין נמען: הגדר כתובת בדשבורד (הגדרות) או BUS_ALERTS_EMAIL_TO ב-.env",
      },
      { status: 400 }
    )
  }

  const { alerts, lastUpdated } = await mergeTransportAlertsFromDisk()
  const structuredById = buildStructuredMapForAlerts(alerts)
  const groqKey = process.env.GROQ_API_KEY?.trim()
  try {
    await attachAiSummariesToAlerts(alerts, groqKey, structuredById, {
      generateMissing: true,
    })
  } catch (e) {
    console.error(
      "[send-alerts-email] AI summaries step failed; applying cache-only and sending anyway:",
      e
    )
    try {
      await attachAiSummariesToAlerts(alerts, undefined, structuredById, {
        generateMissing: false,
      })
    } catch {
      /* נמשיך לשליחה עם מה שיש בזיכרון */
    }
  }

  const slice = filterAlerts(alerts, filter)
  if (slice.length === 0) {
    console.log(
      "[send-alerts-email] skip send: no alerts for filter",
      filter,
      "totalAlerts=",
      alerts.length
    )
    return NextResponse.json({
      ok: true,
      sent: 0,
      emailSkipped: true,
      skipReason: "no_alerts_for_filter",
      filter,
      totalAlerts: alerts.length,
    })
  }

  const port = Number(process.env.BUS_ALERTS_SMTP_PORT ?? "587")
  const secure = process.env.BUS_ALERTS_SMTP_SECURE === "1"
  const user = process.env.BUS_ALERTS_SMTP_USER?.trim()
  const pass = process.env.BUS_ALERTS_SMTP_PASS ?? ""

  console.log(
    "[send-alerts-email] SMTP:",
    `host=${host}`,
    `port=${port}`,
    `secure=${secure}`,
    `authUser=${user ? "(set)" : "(none)"}`,
    `from=${from}`,
    `to=${recipient}`
  )

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    ...(user ? { auth: { user, pass } } : {}),
  })

  const html = buildHtmlEmail(slice, filter)
  const text = slice
    .map((a) => {
      const sum =
        sanitizeAiSummaryOutput(a.aiSummary ?? "").trim() || "מעבד סיכום..."
      return `${agencyLabelForAlert(a)}\n${a.lineNumbers.join(", ")}\n${a.title}\n\n${a.fullContent}\n\nסיכום: ${sum}\n${a.link}\n`
    })
    .join("\n---\n")

  try {
    await transporter.sendMail({
      from,
      to: recipient,
      subject: `[תחבורה] דוח התראות (${slice.length}) · ${filter} · ${lastUpdated.slice(0, 10)}`,
      text,
      html,
    })
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { responseCode?: string; command?: string }
    console.error("[send-alerts-email] sendMail failed:", e)
    console.error(
      "[send-alerts-email] nodemailer detail:",
      "message=",
      err?.message,
      "code=",
      err?.code,
      "errno=",
      err?.errno,
      "syscall=",
      err?.syscall,
      "responseCode=",
      err?.responseCode,
      "command=",
      err?.command,
      "stack=",
      e instanceof Error ? e.stack : undefined
    )
    return NextResponse.json(
      {
        error:
          e instanceof Error
            ? e.message
            : "שליחת המייל נכשלה (SMTP). בדוק BUS_ALERTS_SMTP_* ו-BUS_ALERTS_EMAIL_FROM/TO.",
      },
      { status: 502 }
    )
  }

  console.log(`[send-alerts-email] ✅ מייל נשלח ל: ${recipient}`)

  return NextResponse.json({
    ok: true,
    sent: slice.length,
    to: recipient,
    filter,
  })
}
