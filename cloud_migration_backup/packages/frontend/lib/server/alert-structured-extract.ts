import type { TransportAlert } from "@/lib/transport-alert"

/** שדות שמועברים למודל — אחרי ניקוי וחילוץ מהטקסט הגולמי */
export interface StructuredAlertForAi {
  reason: string
  street: string
  city: string
  lineNumbers: string[]
  direction: string
  formattedSchedule: string
  /** קטע טקסט מנורמל לגיבוי (עברית) */
  rawSanitizedSnippet: string
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

/** מסיר רעש נפוץ לפני חילוץ */
export function sanitizeRawAlertText(title: string, fullContent: string): string {
  const combined = collapseWs(`${title}\n${fullContent}`)
  return combined
    .replace(/\u200f|\u200e/g, "")
    .replace(/#{1,6}\s*/g, "")
    .slice(0, 14_000)
}

const REASON_HINTS: [RegExp, string][] = [
  [/עבודות\s+תשתית|תשתית/i, "עבודות תשתית"],
  [/עבודות(?!\s*תשתית)/i, "עבודות"],
  [/הפגנה|מחאה/i, "הפגנה"],
  [/תאונ[הת]|תאונת\s+דרכים/i, "תאונה"],
  [/חסימה|חסימת/i, "חסימה"],
  [/סגירת|סגירה/i, "סגירת כביש"],
  [/אירוע(?!\s+מיוחד)/i, "אירוע"],
  [/ביטול\s+תחנ|מבוטלות/i, "ביטול תחנות"],
  [/מבצע|שאגת/i, "מבצע תנועה"],
]

const CITY_PATTERNS: [RegExp, string][] = [
  [/תל[-\s]?אביב|ת\"?א\b/i, "תל אביב"],
  [/ירושלים/i, "ירושלים"],
  [/חיפה/i, "חיפה"],
  [/באר\s*שבע/i, "באר שבע"],
  [/בת\s*ים/i, "בת ים"],
  [/רמת\s*גן/i, "רמת גן"],
  [/בני\s*ברק/i, "בני ברק"],
  [/מודיעין/i, "מודיעין"],
  [/הרצליה/i, "הרצליה"],
  [/נתניה/i, "נתניה"],
  [/אשדוד/i, "אשדוד"],
  [/פתח\s*תקווה/i, "פתח תקווה"],
]

function guessReason(text: string): string {
  const t = text.slice(0, 2000)
  for (const [re, label] of REASON_HINTS) {
    if (re.test(t)) return label
  }
  if (/עקב|בשל|בגלל/i.test(t)) {
    const m = t.match(/(?:עקב|בשל|בגלל)\s+([^,.]{3,80})/i)
    if (m?.[1]) return collapseWs(m[1])
  }
  return "שינוי תנועה"
}

function extractStreet(text: string): string {
  const m =
    text.match(/ברחוב\s+([^,.]+?)(?:\s|,|\.|$)/i) ||
    text.match(/רחוב\s+([^,.]+?)(?:\s|,|\.|$)/i) ||
    text.match(/ברח['׳]\s*([^,.]+?)(?:\s|,|\.|$)/i)
  return m?.[1] ? collapseWs(m[1]) : ""
}

function extractCity(text: string): string {
  for (const [re, name] of CITY_PATTERNS) {
    if (re.test(text)) return name
  }
  const m = text.match(/ב([א-ת][א-ת\s]{2,25})(?:,|\.|\s|$)/)
  if (m?.[1] && m[1].length < 30) return collapseWs(m[1])
  return ""
}

function extractDirection(text: string): string {
  const m =
    text.match(/לכיוון\s+([^,.;\n]{2,40})/i) ||
    text.match(/כיוון\s+([^,.;\n]{2,40})/i) ||
    text.match(/מכיוון\s+([^,.;\n]{2,40})/i)
  if (!m?.[1]) return ""
  let d = collapseWs(m[1])
  if (/צפון|דרום|מזרח|מערב/i.test(d)) return d
  return d.length <= 35 ? d : ""
}

function collectLineNumbers(alert: TransportAlert, text: string): string[] {
  const fromMeta = alert.lineNumbers
    .map((x) => String(x).trim())
    .filter((x) => x && x !== "—")
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of fromMeta) {
    const n = x.replace(/^1:/, "").split(":").pop() ?? x
    if (!seen.has(n)) {
      seen.add(n)
      out.push(n)
    }
  }
  const reGlobal = /(?:קו|קווים)\s*:?\s*([\dא-ת׳/,\s]+)/gi
  let mm: RegExpExecArray | null
  const t = text.slice(0, 4000)
  while ((mm = reGlobal.exec(t)) !== null) {
    const chunk = mm[1] ?? ""
    const nums = chunk.match(/\d{1,4}/g) ?? []
    for (const n of nums) {
      if (!seen.has(n)) {
        seen.add(n)
        out.push(n)
      }
    }
  }
  return out.slice(0, 24)
}

function buildFormattedSchedule(alert: TransportAlert, text: string): string {
  const start = alert.dateRange.start?.trim() || ""
  const end = alert.dateRange.end?.trim() || ""
  const times = [...text.matchAll(/\b\d{1,2}:\d{2}\b/g)].map((m) => m[0])
  const uniqueTimes = [...new Set(times)].slice(0, 8)
  const parts: string[] = []
  if (start || end) {
    parts.push([start, end].filter(Boolean).join(" — "))
  }
  if (uniqueTimes.length >= 2) {
    parts.push(`שעות: ${uniqueTimes[0]}–${uniqueTimes[1]}`)
  } else if (uniqueTimes.length === 1) {
    parts.push(`שעה: ${uniqueTimes[0]}`)
  }
  return collapseWs(parts.join(" | ")) || "לא צוין במפורש — הסק מהטקסט"
}

/**
 * ממפה התראה (כולל Bus Nearby / אחר) לשדות מובנים לפני שליחה ל-Gemini.
 */
export function extractStructuredFromTransportAlert(
  alert: TransportAlert
): StructuredAlertForAi {
  const rawSanitizedSnippet = sanitizeRawAlertText(alert.title, alert.fullContent)
  const text = rawSanitizedSnippet

  return {
    reason: guessReason(text),
    street: extractStreet(text),
    city: extractCity(text) || extractCity(alert.title),
    lineNumbers: collectLineNumbers(alert, text),
    direction: extractDirection(text),
    formattedSchedule: buildFormattedSchedule(alert, text),
    rawSanitizedSnippet,
  }
}
