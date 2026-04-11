import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"

import type { TransportAlert } from "@/lib/transport-alert"
import {
  fetchScraperDataJson,
  getScraperApiBaseUrl,
} from "@/lib/server/scraper-api"
import { resolveCanonicalDataDir } from "@/lib/server/workspace-paths"

const FILE = () =>
  path.join(resolveCanonicalDataDir(), "alert-activity.json")

type ActivityFile = {
  byId: Record<string, { firstSeenAt: string; lastSeenAt: string }>
}

async function readFileJson(): Promise<ActivityFile> {
  if (getScraperApiBaseUrl()) {
    const j = (await fetchScraperDataJson(
      "alert-activity.json"
    )) as ActivityFile | null
    if (j?.byId && typeof j.byId === "object") {
      return j
    }
  }
  try {
    const raw = await readFile(FILE(), "utf-8")
    const j = JSON.parse(raw) as ActivityFile
    if (j?.byId && typeof j.byId === "object") return j
  } catch {
    /* */
  }
  return { byId: {} }
}

function startOfTodayIso(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

function isTodayFirstSeen(firstSeenAt: string): boolean {
  const t = Date.parse(firstSeenAt)
  if (Number.isNaN(t)) return false
  const start = Date.parse(startOfTodayIso())
  return t >= start
}

/** מעדכן firstSeen/lastSeen ומחזיר סימון "חדש היום" לפי firstSeen */
export async function applyAlertActivityTimestamps(
  alerts: TransportAlert[]
): Promise<void> {
  const now = new Date().toISOString()
  const data = await readFileJson()
  let changed = false
  for (const a of alerts) {
    const prev = data.byId[a.id]
    if (!prev) {
      data.byId[a.id] = { firstSeenAt: now, lastSeenAt: now }
      a.firstSeenAt = now
      a.lastSeenAt = now
      a.isNew = isTodayFirstSeen(now)
      changed = true
    } else {
      a.firstSeenAt = prev.firstSeenAt
      a.lastSeenAt = now
      data.byId[a.id] = { firstSeenAt: prev.firstSeenAt, lastSeenAt: now }
      a.isNew = isTodayFirstSeen(prev.firstSeenAt)
      changed = true
    }
  }
  if (changed) {
    await mkdir(path.dirname(FILE()), { recursive: true })
    await writeFile(FILE(), JSON.stringify(data, null, 2), "utf-8")
  }
}

export { splitAlertsNewVsExisting } from "@/lib/alert-split"
