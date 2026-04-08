import type { TransportAlert } from "@/lib/transport-alert"

/** מזהה תוכן מקישור אגד / meta (תואם לסקרייפר) */
export function eggedContentIdFromLinkAndMeta(
  link: string,
  meta?: Record<string, unknown>
): string {
  const fromMeta = meta?.contentId
  if (typeof fromMeta === "string" && fromMeta.trim()) return fromMeta.trim()
  const url = String(link ?? "").trim()
  const m =
    url.match(/\/traffic-updates\/(\d+)/i) ??
    url.match(/(\d{8,})(?:\/?|[?#]|$)/)
  return (m?.[1] ?? "").trim()
}

/**
 * מפתח יחיד ל־ai-summaries ול־TransportAlert.id לאגד:
 * `egged-${contentId || id}` כאשר id הוא מזהה המקור (מפתח אובייקט או scan-*).
 */
export function eggedAlertSummaryId(
  contentId: string,
  sourceIdFallback: string
): string {
  const c = contentId.trim()
  const f = sourceIdFallback.trim()
  return `egged-${c || f}`
}

export function isEggedPipelineAlert(a: TransportAlert): boolean {
  return a.dataSource === "egged" || a.scanSourceId === "egged"
}

/**
 * מפתח קנוני לכתיבה/התאמה — תואם ל־aggregate-transport-json.
 */
export function eggedSummaryCacheKey(alert: TransportAlert): string {
  const c = (alert.contentId ?? "").trim()
  const id = alert.id.trim()
  const withoutPrefix = id.startsWith("egged-") ? id.slice("egged-".length) : id
  return eggedAlertSummaryId(c, withoutPrefix)
}

/** סדר חיפוש במטמון: מפתח קנון, ואז מזהה התראה כפי שמגיע מה־JSON/סריקה */
export function eggedSummaryLookupKeys(alert: TransportAlert): string[] {
  return [...new Set([eggedSummaryCacheKey(alert), alert.id.trim()].filter(Boolean))]
}
