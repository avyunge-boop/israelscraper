/**
 * SMTP config for bus alerts (send-alerts-email, test-email).
 * BUS_ALERTS_SMTP_PASS is trimmed — Cloud Run / secret manager sometimes adds newlines.
 */
import nodemailer from "nodemailer"

export type BusAlertsSmtpEnv = {
  host: string | undefined
  port: number
  secure: boolean
  user: string | undefined
  /** Trimmed app password / secret */
  pass: string
  from: string | undefined
}

export function readBusAlertsSmtpEnv(): BusAlertsSmtpEnv {
  const host = process.env.BUS_ALERTS_SMTP_HOST?.trim()
  const port = Number(process.env.BUS_ALERTS_SMTP_PORT ?? "587")
  const secure = process.env.BUS_ALERTS_SMTP_SECURE === "1"
  const user = process.env.BUS_ALERTS_SMTP_USER?.trim()
  const rawPass = process.env.BUS_ALERTS_SMTP_PASS
  const pass =
    typeof rawPass === "string" ? rawPass.trim() : String(rawPass ?? "").trim()
  const from = process.env.BUS_ALERTS_EMAIL_FROM?.trim()
  return {
    host,
    port,
    secure,
    user,
    pass,
    from,
  }
}

export function createBusAlertsTransport(): ReturnType<
  typeof nodemailer.createTransport
> {
  const { host, port, secure, user, pass } = readBusAlertsSmtpEnv()
  if (!host) {
    throw new Error("BUS_ALERTS_SMTP_HOST is not set")
  }
  return nodemailer.createTransport({
    host,
    port,
    secure,
    ...(user ? { auth: { user, pass } } : {}),
  })
}
