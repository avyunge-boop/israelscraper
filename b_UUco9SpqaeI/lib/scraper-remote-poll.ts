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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function backoffMs(attempt: number): number {
  const base = Math.min(2500 * 2 ** attempt, 25_000)
  return base + Math.floor(Math.random() * 400)
}

export async function runScrapeRemotePoll(
  body: object,
  handlers: ScanSseHandlers
): Promise<{ ok: boolean; exitCode: number }> {
  const bodyStr = JSON.stringify(body)
  handlers.onLog?.(`POST /run-scrape stream body: ${bodyStr}`)

  const maxRetries = 6
  let res: Response | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const r = await fetch("/api/scraper-bridge/run-stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: bodyStr,
      cache: "no-store",
    })
    res = r

    if (r.status === 404 || r.status === 405) {
      const err = new Error(
        `scraper-bridge/run-stream returned HTTP ${r.status} (route not deployed on this dashboard)`
      ) as ScraperBridgeMissingError
      err.code = SCRAPER_BRIDGE_MISSING
      throw err
    }

    if (r.status !== 429 && r.status !== 503) {
      break
    }
    if (attempt === maxRetries) {
      break
    }

    let waitMs = backoffMs(attempt)
    const ra = r.headers.get("retry-after")
    if (ra) {
      const n = Number(ra)
      if (Number.isFinite(n) && n > 0) {
        waitMs = Math.min(n * 1000, 60_000)
      }
    }
    handlers.onLog?.(
      `run-stream HTTP ${r.status}, retry ${attempt + 1}/${maxRetries} after ${waitMs}ms`
    )
    await r.text().catch(() => {})
    await sleep(waitMs)
  }

  if (!res) {
    throw new Error("run-stream: no response")
  }
  return consumeScanSseResponse(res, handlers)
}
