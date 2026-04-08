import type { TransportAlert } from "@/lib/transport-alert"

function startOfLocalDayMs(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** חלוקה ללקוח/שרת — התראות שנראו לראשונה היום (לפי firstSeenAt / isNew) */
export function splitAlertsNewVsExisting(
  alerts: TransportAlert[]
): { newToday: TransportAlert[]; existing: TransportAlert[] } {
  const dayStart = startOfLocalDayMs()
  const newToday: TransportAlert[] = []
  const existing: TransportAlert[] = []
  for (const a of alerts) {
    const fs = a.firstSeenAt ? Date.parse(a.firstSeenAt) : NaN
    const isNewDay =
      a.isNew === true ||
      (!Number.isNaN(fs) && fs >= dayStart)
    if (isNewDay) newToday.push(a)
    else existing.push(a)
  }
  return { newToday, existing }
}
