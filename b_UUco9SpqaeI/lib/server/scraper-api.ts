/**
 * כאשר הדשבורד רץ בנפרד מהסקרייפר (למשל Cloud Run), מגדירים SCRAPER_API_URL
 * לבסיס ה-HTTP של שירות הסקרייפר (ללא סלאש בסוף).
 */

export function getScraperApiBaseUrl(): string | undefined {
  const u = process.env.SCRAPER_API_URL?.trim()
  if (!u) return undefined
  return u.replace(/\/+$/, "")
}

export async function fetchScraperDataFileText(
  fileName: string
): Promise<string | null> {
  const base = getScraperApiBaseUrl()
  if (!base) return null
  const url = `${base}/data/${encodeURIComponent(fileName)}`
  try {
    const res = await fetch(url, { cache: "no-store" })
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
