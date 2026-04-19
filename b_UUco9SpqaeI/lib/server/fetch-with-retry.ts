/**
 * Retries transient HTTP failures common on Cloud Run / edge (429, 503).
 * Drains the response body before waiting so the connection can be reused.
 */

const DEFAULT_RETRY_STATUSES = [429, 503]

function backoffWithJitterMs(attempt: number): number {
  const cap = 25_000
  const base = Math.min(2500 * 2 ** attempt, cap)
  return base + Math.floor(Math.random() * Math.min(500, base / 4))
}

export type FetchWithRetryOptions = {
  maxRetries?: number
  retryStatuses?: number[]
}

export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit,
  opts?: FetchWithRetryOptions
): Promise<Response> {
  const maxRetries = opts?.maxRetries ?? 6
  const retryStatuses = new Set(
    opts?.retryStatuses ?? DEFAULT_RETRY_STATUSES
  )

  let last: Response | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(input, init)
    last = res

    if (!retryStatuses.has(res.status) || attempt === maxRetries) {
      return res
    }

    let waitMs = backoffWithJitterMs(attempt)
    const ra = res.headers.get("retry-after")
    if (ra) {
      const n = Number(ra)
      if (Number.isFinite(n) && n > 0) {
        waitMs = Math.min(n * 1000, 60_000)
      }
    }
    await res.text().catch(() => {})
    await new Promise((r) => setTimeout(r, waitMs))
  }

  return last as Response
}
