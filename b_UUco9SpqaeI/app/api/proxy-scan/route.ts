import { execSync, spawn } from "child_process"
import { existsSync } from "fs"
import path from "path"
import { NextResponse } from "next/server"

import { getScraperApiBaseUrl } from "@/lib/server/scraper-api"
import {
  isBusnearbyRoutesDatabaseEmpty,
  resolveOrchestratorRepoRoot,
} from "@/lib/server/workspace-paths"

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

function touchesBusnearbyScan(args: string[]): boolean {
  return (
    args.includes("--all") ||
    args.some((a) => /^--agency=busnearby$/i.test(a))
  )
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

function buildCliArgs(body: ScanBody): string[] {
  const { all, agency, forceRefresh } = parseScanBody(body)
  let cliArgs = all ? ["--all"] : [`--agency=${agency}`]
  cliArgs = withBusnearbyRefreshIfNeeded(cliArgs, { all, agency, forceRefresh })
  return cliArgs
}

type RunOrchestratorOpts = {
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

/** Cloud Run: סריקה דרך שירות הסקרייפר (לא pnpm מקומי). */
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

  const res = await fetch(`${base}/run-scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  })
  const text = await res.text()
  let data: {
    ok?: boolean
    exitCode?: number
    stdout?: string
    stderr?: string
    error?: string
  }
  try {
    data = JSON.parse(text) as typeof data
  } catch {
    throw new Error(
      `Scraper API returned non-JSON (${res.status}): ${text.slice(0, 200)}`
    )
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
      const tsxCli = path.join(
        packagedRoot,
        "node_modules",
        "tsx",
        "dist",
        "cli.mjs"
      )
      const nodeBin = resolveNodeExecutable()
      const spawnEnv = { ...env } as Record<string, string | undefined>
      delete spawnEnv.ELECTRON_RUN_AS_NODE
      child = spawn(nodeBin, [
        tsxCli,
        path.join(packagedRoot, "src", "orchestrator.ts"),
        ...args,
      ], {
        cwd: packagedRoot,
        env: spawnEnv as NodeJS.ProcessEnv,
      })
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

  // בלי קבצים מקומיים (Cloud Run + SCRAPER_API_URL) אין routes-database בדיסק — הבדיקה תמיד "ריקה" ואסור לחסום.
  if (
    !getScraperApiBaseUrl() &&
    touchesBusnearbyScan(cliArgs) &&
    !cliArgs.includes("--refresh") &&
    (await isBusnearbyRoutesDatabaseEmpty())
  ) {
    return NextResponse.json(
      {
        error:
          "אין מסלולי Bus Nearby בקובץ routes-database.json. מהטרמינל: pnpm run init-routes. או בדשבורד הפעל סריקה עם «רענון מסלולים» (שולח refresh).",
        code: "BUSNEARBY_ROUTES_REQUIRED",
      },
      { status: 400 }
    )
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
          const { code, stdout, stderr } = getScraperApiBaseUrl()
            ? await runOrchestratorViaScraperApi(body, {
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
            : await runOrchestrator(cliArgs, {
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
