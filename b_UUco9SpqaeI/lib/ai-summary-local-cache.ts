/**
 * מטמון סיכומי AI ב-localStorage לפי epoch של נתוני הסריקה (meta.lastUpdated).
 * רענון דף בלי סריקה חדשה — אותו epoch → משחזרים סיכומים מהמטמון (בלי לבקש יצירה מחדש מהשרת).
 */
import type { TransportAlert } from "@/lib/transport-alert"

const LS_KEY = "transport-dashboard-ai-summary-v1"

type Stored = {
  epoch: string
  byId: Record<string, string>
}

function readStored(): Stored | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Stored
    if (typeof p.epoch !== "string" || typeof p.byId !== "object" || !p.byId)
      return null
    return p
  } catch {
    return null
  }
}

function writeStored(s: Stored): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s))
  } catch {
    /* quota / private mode */
  }
}

/** מפתח יציב לתצוגה: id + אופציונלי contentId לאגד */
function cacheKeyForAlert(a: TransportAlert): string {
  const cid = (a.contentId ?? "").trim()
  return cid ? `${a.id}::${cid}` : a.id
}

/**
 * ממזג סיכומים מהמטמון המקומי. epoch משתנה כש-scan-export מתעדכן (lastUpdated משרת המיזוג).
 */
export function mergeAiSummariesWithLocalCache(
  alerts: TransportAlert[],
  dataEpoch: string
): TransportAlert[] {
  if (typeof window === "undefined" || !dataEpoch) return alerts

  const stored = readStored()

  if (!stored || stored.epoch !== dataEpoch) {
    const next: Record<string, string> = {}
    for (const a of alerts) {
      const s = a.aiSummary?.trim()
      if (s) next[cacheKeyForAlert(a)] = s
    }
    writeStored({ epoch: dataEpoch, byId: next })
    return alerts
  }

  const out = alerts.map((a) => {
    const key = cacheKeyForAlert(a)
    const cached = stored.byId[key]?.trim()
    if (cached) return { ...a, aiSummary: cached }
    return a
  })

  const next: Record<string, string> = { ...stored.byId }
  for (const a of out) {
    const key = cacheKeyForAlert(a)
    const s = a.aiSummary?.trim()
    if (s) next[key] = s
  }
  writeStored({ epoch: dataEpoch, byId: next })
  return out
}
