import { execSync, spawn } from "child_process"
import { existsSync } from "fs"
import path from "path"
import { NextResponse } from "next/server"

import { fetchWithRetry } from "@/lib/server/fetch-with-retry"
import { getScraperApiBaseUrl } from "@/lib/server/scraper-api"
import { resolveOrchestratorRepoRoot } from "@/lib/server/workspace-paths"

export const dynamic = "force-dynamic"
export const maxDuration = 900

const KNOWN_AGENCIES = new Set([
  "busnearby",
  "egged",
  "dan",
  "kavim",
  "metropoline",
])

type ScanBody = {
  agency?: string
  all?: boolean
  refresh?: boolean
  maxRoutes?: number
  fullScan?: boolean
}

function parseScanBody(b: ScanBody): {
  all: boolean
  agency: string | null
  forceRefresh: boolean
} {
  let all = false
  let agency: string | null = null
  const forceRefresh = b?.refresh === true
  if (b?.all === true) {
    all = true
  } else if (typeof b?.agency === "string") {
    const a = b.agency.trim().toLowerCase()
    if (a === "all" || a === "") all = true
    else if (KNOWN_AGENCIES.has(a)) agency = a
    else {
      throw new Error(`מזהה סוכנות לא מוכר: ${b.agency}`)
    }
  } else {
    all = true
  }
  return { all, agency, forceRefresh }
}

function withBusnearbyRefreshIfNeeded(
  args: string[],
  opts: { all: boolean; agency: string | null; forceRefresh: boolean }
): string[] {
  if (args.includes("--refresh")) return args
  const touchesBusnearby = opts.all || opts.agency === "busnearby"
  if (!touchesBusnearby) return args
  if (!opts.forceRefresh) return args
  return [...args, "--refresh"]
}

function resolveNodeExecutable(): string {
  const fromEnv = process.env.NODE_BINARY?.trim()
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  for (const p of [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ]) {
    if (existsSync(p)) return p
  }
  try {
    const out = execSync("command -v node", {
      encoding: "utf-8",
      env: process.env,
    }).trim()
    if (out && existsSync(out)) return out
  } catch {
    /* */
  }
  throw new Error(
    "Node.js not found. Install Node 20+ or set NODE_BINARY to the full path to node."
  )
}

function maxRoutesFromBody(body: ScanBody): number | null {
  if (!body || typeof body !== "object" || !("maxRoutes" in body)) {
    return null
  }
  const v = body.maxRoutes
  if (typeof v !== "number" || !Number.isFinite(v)) return null
  const cap = Math.floor(v)
  return cap > 0 ? cap : null
}

function buildCliArgs(body: ScanBody): string[] {
  const { all, agency, forceRefresh } = parseScanBody(body)
  let cliArgs = all ? ["--all"] : [`--agency=${agency}`]
  cliArgs = withBusnearbyRefreshIfNeeded(cliArgs, { all, agency, forceRefresh })
  const cap = maxRoutesFromBody(body)
  if (cap != null) {
    cliArgs = [...cliArgs, `--max-routes=${cap}`]
  }
  if (body?.fullScan === true) {
    cliArgs = [...cliArgs, "--full-scan"]
  }
  return cliArgs
}

type RunOrchestratorOpts = {
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Cloud Run: סריקה דרך שירות הסקרייפר (לא pnpm מקומי). POST /run-scrape מחזיר מיד; ממתינים ל-/status ואז /last-result. */
async function runOrchestratorViaScraperApi(
  body: ScanBody,
  opts?: RunOrchestratorOpts
): Promise<{ code: number; stdout: string; stderr: string }> {
  const base = getScraperApiBaseUrl()
  if (!base) {
    throw new Error("SCRAPER_API_URL is not set")
  }
  const { all, agency, forceRefresh } = parseScanBody(body)
  const payload: Record<string, unknown> = {}
  if (all) payload.all = true
  else if (agency) payload.agency = agency
  else payload.all = true
  if (forceRefresh) payload.refresh = true
  const cap = maxRoutesFromBody(body)
  if (cap != null) payload.maxRoutes = cap
  if (body?.fullScan === true) payload.fullScan = true

  const res = await fetchWithRetry(`${base}/run-scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  })
  const text = await res.text()
  let data: {
    ok?: boolean
    started?: boolean
    exitCode?: number
    stdout?: string
    stderr?: string
    error?: string
    agency?: string
  }
  try {
    data = JSON.parse(text) as typeof data
  } catch {
    throw new Error(
      `Scraper API returned non-JSON (${res.status}): ${text.slice(0, 200)}`
    )
  }

  if (res.status === 409) {
    throw new Error(
      `Scraper API: ${data.error ?? "scrape already running"}${data.agency ? ` (${data.agency})` : ""}`
    )
  }

  if (data.started === true && data.ok === true) {
    const pollMs = 3000
    for (;;) {
      await sleep(pollMs)
      const stRes = await fetchWithRetry(`${base}/status`, {
        cache: "no-store",
      })
      const stText = await stRes.text()
      let st: { running?: boolean }
      try {
        st = JSON.parse(stText) as { running?: boolean }
      } catch {
        throw new Error(`Scraper API /status non-JSON: ${stText.slice(0, 200)}`)
      }
      if (!st.running) break
    }
    const lrRes = await fetchWithRetry(`${base}/last-result`, {
      cache: "no-store",
    })
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
      throw new Error(
        `Scraper API /last-result non-JSON: ${lrText.slice(0, 200)}`
      )
    }
    if (!lrRes.ok) {
      throw new Error(lr.error ?? `last-result HTTP ${lrRes.status}`)
    }
    const stdout = lr.stdout ?? ""
    let stderr = lr.stderr ?? ""
    if (lr.gcsError) {
      stderr = stderr
        ? `${stderr}\n[GCS] ${lr.gcsError}`
        : `[GCS] ${lr.gcsError}`
    }
    opts?.onStdout?.(stdout)
    opts?.onStderr?.(stderr)
    return {
      code: typeof lr.exitCode === "number" ? lr.exitCode : 1,
      stdout,
      stderr,
    }
  }

  const stdout = data.stdout ?? ""
  const stderr = data.stderr ?? ""
  opts?.onStdout?.(stdout)
  opts?.onStderr?.(stderr)

  if (typeof data.exitCode === "number") {
    return { code: data.exitCode, stdout, stderr }
  }
  if (typeof data.error === "string" && data.error) {
    throw new Error(data.error)
  }
  const code = data.ok === true ? 0 : 1
  if (!res.ok && code === 0) {
    throw new Error(`Scraper API HTTP ${res.status}`)
  }
  return { code, stdout, stderr }
}

function runOrchestrator(
  args: string[],
  opts?: RunOrchestratorOpts
): Promise<{
  code: number
  stdout: string
  stderr: string
}> {
  const repoRoot = resolveOrchestratorRepoRoot()
  const packagedRoot = process.env.ISRAEL_SCRAPER_PACKAGED_ROOT?.trim()
  const env = {
    ...process.env,
    SCRAPER_ORCHESTRATOR_SKIP_ALL_EMAIL: "1",
  }

  return new Promise((resolve, reject) => {
    const out: Buffer[] = []
    const err: Buffer[] = []

    let child: ReturnType<typeof spawn>
    if (packagedRoot) {
      const nodeBin = resolveNodeExecutable()
      const spawnEnv = { ...env } as Record<string, string | undefined>
      delete spawnEnv.ELECTRON_RUN_AS_NODE
      /** נבנה ב־desktop:prepare — בלי tsx/esbuild (אחרת חסר @esbuild/darwin-* ב־.app) */
      const bundledOrchestrator = path.join(
        packagedRoot,
        "dist",
        "orchestrator.mjs"
      )
      if (existsSync(bundledOrchestrator)) {
        child = spawn(nodeBin, [bundledOrchestrator, ...args], {
          cwd: packagedRoot,
          env: spawnEnv as NodeJS.ProcessEnv,
        })
      } else {
        const tsxCli = path.join(
          packagedRoot,
          "node_modules",
          "tsx",
          "dist",
          "cli.mjs"
        )
        child = spawn(nodeBin, [tsxCli, path.join(packagedRoot, "src", "orchestrator.ts"), ...args], {
          cwd: packagedRoot,
          env: spawnEnv as NodeJS.ProcessEnv,
        })
      }
    } else {
      const pnpmArgs = [
        "--filter",
        "@workspace/scraper",
        "run",
        "scan",
        "--",
        ...args,
      ]
      child = spawn("pnpm", pnpmArgs, {
        cwd: repoRoot,
        env,
        shell: true,
      })
    }
    child.stdout?.on("data", (c) => {
      const buf = Buffer.from(c)
      out.push(buf)
      const text = buf.toString("utf-8")
      console.log(`[Scraper]: ${text}`)
      opts?.onStdout?.(text)
    })
    child.stderr?.on("data", (c) => {
      const buf = Buffer.from(c)
      err.push(buf)
      const text = buf.toString("utf-8")
      console.error(`[Scraper Error]: ${text}`)
      opts?.onStderr?.(text)
    })
    child.on("error", reject)
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8"),
      })
    })
  })
}

function parseProgressLines(text: string): unknown[] {
  const events: unknown[] = []
  for (const line of text.split("\n")) {
    const m = line.match(/\[SCRAPER_PROGRESS\]\s*(.+)/)
    if (!m?.[1]) continue
    try {
      events.push(JSON.parse(m[1]))
    } catch {
      /* */
    }
  }
  return events
}

export async function POST(request: Request) {
  const url = new URL(request.url)
  const streamMode = url.searchParams.get("stream") === "1"

  let body: ScanBody = {}
  try {
    body = (await request.json()) as ScanBody
  } catch {
    body = {}
  }

  let cliArgs: string[]
  try {
    cliArgs = buildCliArgs(body)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 400 })
  }

  if (streamMode) {
    const encoder = new TextEncoder()
    const tail = 80_000
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: object) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)
          )
        }
        try {
          const base = getScraperApiBaseUrl()
          if (base) {
            const { all, agency, forceRefresh } = parseScanBody(body)
            const payload: Record<string, unknown> = {}
            if (all) payload.all = true
            else if (agency) payload.agency = agency
            else payload.all = true
            if (forceRefresh) payload.refresh = true
            const capStream = maxRoutesFromBody(body)
            if (capStream != null) payload.maxRoutes = capStream
            if (body?.fullScan === true) payload.fullScan = true

            const upstream = await fetch(`${base}/run-scrape?stream=1`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "text/event-stream",
              },
              body: JSON.stringify(payload),
              cache: "no-store",
            })
            if (upstream.status === 409) {
              const t = await upstream.text()
              let msg = "scrape already running"
              try {
                const j = JSON.parse(t) as { error?: string; agency?: string }
                msg = j.error ?? msg
                if (j.agency) msg += ` (${j.agency})`
              } catch {
                /* */
              }
              throw new Error(`Scraper API: ${msg}`)
            }
            if (!upstream.ok) {
              const t = await upstream.text()
              throw new Error(
                `Scraper API stream HTTP ${upstream.status}: ${t.slice(0, 200)}`
              )
            }
            const reader = upstream.body?.getReader()
            if (!reader) {
              throw new Error("Scraper API stream: empty response body")
            }
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              if (value) controller.enqueue(value)
            }
            return
          }

          const { code, stdout, stderr } = await runOrchestrator(cliArgs, {
            onStdout: (text) => {
              send({ type: "log", channel: "stdout", text })
              for (const ev of parseProgressLines(text)) {
                send({ type: "progress", payload: ev })
              }
            },
            onStderr: (text) => {
              send({ type: "log", channel: "stderr", text })
            },
          })
          send({
            type: "done",
            ok: code === 0,
            exitCode: code,
            stdout: stdout.length > tail ? stdout.slice(-tail) : stdout,
            stderr: stderr.length > tail ? stderr.slice(-tail) : stderr,
          })
        } catch (e) {
          send({
            type: "error",
            message: e instanceof Error ? e.message : String(e),
          })
        } finally {
          controller.close()
        }
      },
    })
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    })
  }

  try {
    const { code, stdout, stderr } = getScraperApiBaseUrl()
      ? await runOrchestratorViaScraperApi(body)
      : await runOrchestrator(cliArgs)
    const tail = 80_000

    return NextResponse.json({
      ok: code === 0,
      exitCode: code,
      stdout: stdout.length > tail ? stdout.slice(-tail) : stdout,
      stderr: stderr.length > tail ? stderr.slice(-tail) : stderr,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json(
      {
        error: getScraperApiBaseUrl()
          ? `שגיאת Scraper API: ${msg}`
          : `לא ניתן להריץ pnpm/סריקה: ${msg}`,
      },
      { status: 500 }
    )
  }
}
