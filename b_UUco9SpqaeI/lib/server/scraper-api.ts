import { fetchWithRetry } from "@/lib/server/fetch-with-retry"

/**
 * כאשר הדשבורד רץ בנפרד מהסקרייפר (למשל Cloud Run), מגדירים SCRAPER_API_URL
 * לבסיס ה-HTTP של שירות הסקרייפר (ללא סלאש בסוף).
 * אם לא הוגדר — משתמשים בברירת המחדל (מטמון GCS דרך GET /data/*).
 */

export const DEFAULT_SCRAPER_API_BASE_URL =
  "https://scraper-api-522107007688.me-west1.run.app"

export function getScraperApiBaseUrl(): string | undefined {
  const raw = process.env.SCRAPER_API_URL
  if (raw !== undefined) {
    const u = raw.trim()
    if (u === "") return undefined
    return u.replace(/\/+$/, "")
  }
  return DEFAULT_SCRAPER_API_BASE_URL.replace(/\/+$/, "")
}

export async function fetchScraperDataFileText(
  fileName: string
): Promise<string | null> {
  const base = getScraperApiBaseUrl()
  if (!base) return null
  const url = `${base}/data/${encodeURIComponent(fileName)}`
  try {
    const res = await fetchWithRetry(url, { cache: "no-store" }, { maxRetries: 5 })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

export async function fetchScraperDataJson(
  fileName: string
): Promise<unknown | null> {
  const text = await fetchScraperDataFileText(fileName)
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}
