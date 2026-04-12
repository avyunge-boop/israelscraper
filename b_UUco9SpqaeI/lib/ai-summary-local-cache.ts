/**
 * מטמון סיכומי AI ב-localStorage — מפתח יציב לפי contentId (אגד) או id.
 * בעת שינוי epoch (אחרי סריקה) לא מאבדים סיכומים שכבר היו במטמון אם השרת עדיין לא החזיר אותם.
 */
import type { TransportAlert } from "@/lib/transport-alert"

const LS_KEY = "transport-dashboard-ai-summary-v2"

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

/** ניסיון מיגרציה מ־v1 */
function readLegacyV1(): Stored | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem("transport-dashboard-ai-summary-v1")
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

/** מפתח עיקרי לשמירה */
export function summaryCacheKeyForAlert(a: TransportAlert): string {
  const cid = (a.contentId ?? "").trim()
  if (cid) return `cid:${cid}`
  return `id:${a.id}`
}

function lookupInMap(
  byId: Record<string, string>,
  a: TransportAlert
): string | undefined {
  const k = summaryCacheKeyForAlert(a)
  const hit = byId[k]?.trim()
  if (hit) return hit
  const cid = (a.contentId ?? "").trim()
  if (cid) {
    const legacy1 = byId[`${a.id}::${cid}`]?.trim()
    if (legacy1) return legacy1
    const legacy2 = byId[`cid:${cid}`]?.trim()
    if (legacy2) return legacy2
  }
  return byId[a.id]?.trim()
}

/**
 * ממזג סיכומים מהמטמון המקומי. epoch משתנה כש-scan-export מתעדכן (meta.lastUpdated משרת המיזוג).
 */
export function mergeAiSummariesWithLocalCache(
  alerts: TransportAlert[],
  dataEpoch: string
): TransportAlert[] {
  if (typeof window === "undefined" || !dataEpoch) return alerts

  let stored = readStored()
  if (!stored) {
    const legacy = readLegacyV1()
    if (legacy) stored = legacy
  }

  const prevById =
    stored?.byId && typeof stored.byId === "object" ? { ...stored.byId } : {}

  const next: Record<string, string> = { ...prevById }

  for (const a of alerts) {
    const key = summaryCacheKeyForAlert(a)
    const fromServer = a.aiSummary?.trim()
    const fromPrev = lookupInMap(prevById, a)
    if (fromServer) {
      next[key] = fromServer
    } else if (fromPrev) {
      next[key] = fromPrev
    }
  }

  writeStored({ epoch: dataEpoch, byId: next })

  return alerts.map((a) => {
    const key = summaryCacheKeyForAlert(a)
    const merged = next[key]?.trim()
    if (merged) return { ...a, aiSummary: merged }
    return a
  })
}
