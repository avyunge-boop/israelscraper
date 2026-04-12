/**
 * סריקה מול Cloud Run: SSE דרך `/api/scraper-bridge/run-stream` (התקדמות בזמן אמת).
 * אם run-stream לא בפריסה (404/405) — נזרק `SCRAPER_BRIDGE_MISSING` והדשבורד נופל ל־proxy-scan.
 */

import { consumeScanSseResponse, type ScanSseHandlers } from "@/lib/scan-sse-consume"

/** Thrown when GET/POST under /api/scraper-bridge/* is missing on the dashboard (stale image). */
export const SCRAPER_BRIDGE_MISSING = "SCRAPER_BRIDGE_MISSING" as const

export type ScraperBridgeMissingError = Error & {
  code: typeof SCRAPER_BRIDGE_MISSING
}

export function isScraperBridgeMissingError(
  e: unknown
): e is ScraperBridgeMissingError {
  return (
    e instanceof Error &&
    (e as ScraperBridgeMissingError).code === SCRAPER_BRIDGE_MISSING
  )
}

export async function runScrapeRemotePoll(
  body: object,
  handlers: ScanSseHandlers
): Promise<{ ok: boolean; exitCode: number }> {
  const bodyStr = JSON.stringify(body)
  handlers.onLog?.(`POST /run-scrape stream body: ${bodyStr}`)

  const res = await fetch("/api/scraper-bridge/run-stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: bodyStr,
    cache: "no-store",
  })
  if (res.status === 404 || res.status === 405) {
    const err = new Error(
      `scraper-bridge/run-stream returned HTTP ${res.status} (route not deployed on this dashboard)`
    ) as ScraperBridgeMissingError
    err.code = SCRAPER_BRIDGE_MISSING
    throw err
  }
  return consumeScanSseResponse(res, handlers)
}
