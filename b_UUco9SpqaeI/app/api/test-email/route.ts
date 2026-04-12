import { NextResponse } from "next/server"

import {
  createBusAlertsTransport,
  readBusAlertsSmtpEnv,
} from "@/lib/server/bus-alerts-smtp"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * בדיקת SMTP עצמאית (בלי סריקה).
 * ב-production: חובה `BUS_ALERTS_TEST_EMAIL_SECRET` ו-query `?secret=...` תואם.
 */
export async function GET(request: Request) {
  const reqUrl = new URL(request.url)
  const isProd = process.env.NODE_ENV === "production"
  const requiredSecret = process.env.BUS_ALERTS_TEST_EMAIL_SECRET?.trim()

  if (isProd) {
    if (!requiredSecret) {
      return NextResponse.json(
        {
          error:
            "In production set BUS_ALERTS_TEST_EMAIL_SECRET and call ?secret=<value>",
        },
        { status: 503 }
      )
    }
    if (reqUrl.searchParams.get("secret") !== requiredSecret) {
      return NextResponse.json({ error: "Forbidden: invalid secret" }, { status: 403 })
    }
  }

  const smtp = readBusAlertsSmtpEnv()
  const { host, port, secure, user, pass, from } = smtp
  const envTo = process.env.BUS_ALERTS_EMAIL_TO?.trim()
  const to = reqUrl.searchParams.get("to")?.trim() || envTo

  console.log(
    "[test-email] GET",
    `host=${host}`,
    `port=${port}`,
    `secure=${secure}`,
    `user_set=${Boolean(user)}`,
    `passLen=${pass.length}`,
    `from=${from}`,
    `to=${to ?? "(missing)"}`
  )

  if (!host || !from) {
    return NextResponse.json(
      {
        error:
          "Missing BUS_ALERTS_SMTP_HOST or BUS_ALERTS_EMAIL_FROM",
        hostSet: Boolean(host),
        fromSet: Boolean(from),
      },
      { status: 503 }
    )
  }
  if (!to) {
    return NextResponse.json(
      {
        error: "No recipient: set ?to= or BUS_ALERTS_EMAIL_TO",
      },
      { status: 400 }
    )
  }

  let transporter: ReturnType<typeof createBusAlertsTransport>
  try {
    transporter = createBusAlertsTransport()
  } catch (e) {
    console.error("[test-email] createTransport:", e)
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "createTransport failed",
      },
      { status: 503 }
    )
  }

  try {
    const info = await transporter.sendMail({
      from,
      to,
      subject: "[תחבורה] בדיקת SMTP — test-email",
      text: "אם קיבלת הודעה זו, ה-SMTP ב-Cloud Run עובד.",
      html: "<p>אם קיבלת הודעה זו, ה-SMTP ב-Cloud Run עובד.</p>",
    })
    console.log("[test-email] ✅ נשלח ל:", to, "messageId=", info?.messageId)
    return NextResponse.json({
      ok: true,
      to,
      messageId: info?.messageId ?? null,
    })
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      responseCode?: string
      command?: string
    }
    console.error("[test-email] sendMail failed:", e)
    console.error(
      "[test-email] nodemailer detail:",
      err?.message,
      err?.code,
      err?.responseCode,
      err?.command,
      e instanceof Error ? e.stack : undefined
    )
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "sendMail failed",
        code: err?.code,
        responseCode: err?.responseCode,
      },
      { status: 502 }
    )
  }
}
