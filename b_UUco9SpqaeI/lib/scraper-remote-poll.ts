/**
 * Cloud Run: POST /run-scrape מחזיר מיד; polling ל-/status כל 3s; לוגים ליומן.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const POLL_MS = 3000

type Handlers = {
  onLog?: (text: string) => void
  onProgress?: (p: Record<string, unknown>) => void
}

export async function runScrapeRemotePoll(
  body: object,
  handlers: Handlers
): Promise<{ ok: boolean; exitCode: number }> {
  const bodyStr = JSON.stringify(body)
  handlers.onLog?.(`POST /run-scrape body: ${bodyStr}`)

  const res = await fetch("/api/scraper-bridge/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bodyStr,
    cache: "no-store",
  })
  const text = await res.text()
  let data: {
    ok?: boolean
    started?: boolean
    error?: string
    agency?: string
  }
  try {
    data = JSON.parse(text) as typeof data
  } catch {
    throw new Error(
      `scraper-bridge/run non-JSON (${res.status}): ${text.slice(0, 300)}`
    )
  }

  if (res.status === 409) {
    throw new Error(
      (data.error ?? "scrape already running") +
        (data.agency ? ` (${data.agency})` : "")
    )
  }
  if (!res.ok) {
    throw new Error(data.error ?? `scraper-bridge/run HTTP ${res.status}`)
  }

  handlers.onLog?.(
    data.started
      ? `הסריקה התחילה — agency: ${data.agency ?? "?"}. מעקב אחרי /status כל ${POLL_MS / 1000}s…`
      : `תשובה: ${text.slice(0, 200)}`
  )

  const scrapeReportedStarted = data.started === true
  const minDoneAt = scrapeReportedStarted ? Date.now() + 5000 : 0

  /** אינדקס תו ב-snapshot המצטבר מהשרת — תמיד שולחים רק את החלק החדש ל-onLog */
  let lastLogLength = 0
  let loggedTruncatedHint = false

  for (;;) {
    await sleep(POLL_MS)

    const stRes = await fetch("/api/scraper-bridge/status", { cache: "no-store" })
    const stText = await stRes.text()
    let st: {
      running?: boolean
      agency?: string
      startedAt?: string
      logSnapshot?: string
      logTruncated?: boolean
    }
    try {
      st = JSON.parse(stText) as typeof st
    } catch {
      throw new Error(`scraper-bridge/status non-JSON: ${stText.slice(0, 200)}`)
    }

    const running = st.running === true
    const snap =
      typeof st.logSnapshot === "string" ? st.logSnapshot : ""

    if (snap.length < lastLogLength) {
      lastLogLength = 0
    }
    if (snap.length > lastLogLength) {
      const delta = snap.slice(lastLogLength)
      if (delta) {
        console.log("[poll] new log delta:", delta.slice(0, 100))
        handlers.onLog?.(delta)
      }
      lastLogLength = snap.length
    }
    if (st.logTruncated === true && running && !loggedTruncatedHint) {
      loggedTruncatedHint = true
      handlers.onLog?.("[יומן סריקה] logTruncated=true (השרת מחזיק רק סוף הזרם)")
    }

    const line = `[status] running=${String(st.running)} · agency=${String(st.agency ?? "")}`
    handlers.onLog?.(line)

    handlers.onProgress?.({
      agency: st.agency ?? "",
      displayName: st.agency ?? "",
      current: st.running ? 1 : 0,
      total: 1,
      alertsFound: 0,
    })

    if (!running) {
      if (scrapeReportedStarted && Date.now() < minDoneAt) {
        handlers.onLog?.(
          "[status] running=false בתוך חלון ההמתנה (5s) — ממשיך לבדוק…"
        )
        continue
      }
      break
    }
  }

  const lrRes = await fetch("/api/scraper-bridge/last-result", { cache: "no-store" })
  const lrText = await lrRes.text()
  let lr: {
    exitCode?: number
    stdout?: string
    stderr?: string
    gcsError?: string
    error?: string
  }
  try {
    lr = JSON.parse(lrText) as typeof lr
  } catch {
    throw new Error(`scraper-bridge/last-result non-JSON: ${lrText.slice(0, 200)}`)
  }
  if (!lrRes.ok) {
    throw new Error(lr.error ?? `last-result HTTP ${lrRes.status}`)
  }
  if (lr.stdout) {
    handlers.onLog?.("— stdout (מלא) —")
    handlers.onLog?.(lr.stdout)
  }
  if (lr.stderr) handlers.onLog?.(`stderr: ${lr.stderr}`)
  if (lr.gcsError) handlers.onLog?.(`GCS: ${lr.gcsError}`)

  const exitCode = typeof lr.exitCode === "number" ? lr.exitCode : 1
  return { ok: exitCode === 0, exitCode }
}
