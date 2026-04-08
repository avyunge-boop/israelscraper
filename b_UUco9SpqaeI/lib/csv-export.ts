import { sanitizeAiSummaryOutput } from "@/lib/ai-summary-sanitize"
import type { TransportAlert } from "@/lib/transport-alert"

const BOM = "\uFEFF"

/**
 * מנקה טקסט לייצוא CSV: מסיר תווי בקרה, מחליף שורות ברווחים (כדי שלא ישברו את הפורמט).
 */
export function normalizeTextForCsv(value: string): string {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function escapeCsvField(value: string): string {
  const t = normalizeTextForCsv(value)
  if (/[",]/.test(t)) {
    return `"${t.replace(/"/g, '""')}"`
  }
  return t
}

/** CSV עם BOM (UTF-8) לפתיחה תקינה ב-Excel בעברית */
export function transportAlertsToCsvString(rows: TransportAlert[]): string {
  const header =
    "מפעיל,מקור נתונים,כותרת,קווים,תאריך התחלה,תאריך סיום,קישור,תוכן מלא,סיכום AI"
  const lines = rows.map((a) =>
    [
      a.provider,
      a.dataSource,
      a.title,
      a.lineNumbers.join(", "),
      a.dateRange.start,
      a.dateRange.end,
      a.link,
      a.fullContent,
      sanitizeAiSummaryOutput(a.aiSummary ?? ""),
    ].map((cell) => escapeCsvField(String(cell))).join(",")
  )
  return BOM + [header, ...lines].join("\r\n")
}
