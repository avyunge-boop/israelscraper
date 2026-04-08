import { spawn } from "child_process"
import { NextResponse } from "next/server"

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
  const needRefresh =
    opts.forceRefresh || isBusnearbyRoutesDatabaseEmpty()
  if (!needRefresh) return args
  return [...args, "--refresh"]
}

function buildCliArgs(body: ScanBody): string[] {
  const { all, agency, forceRefresh } = parseScanBody(body)
  let cliArgs = all ? ["--all"] : [`--agency=${agency}`]
  cliArgs = withBusnearbyRefreshIfNeeded(cliArgs, { all, agency, forceRefresh })
  return cliArgs
}

function runOrchestrator(
  args: string[],
  opts?: {
    onStdout?: (chunk: string) => void
    onStderr?: (chunk: string) => void
  }
): Promise<{
  code: number
  stdout: string
  stderr: string
}> {
  const repoRoot = resolveOrchestratorRepoRoot()
  const pnpmArgs = ["--filter", "@workspace/scripts", "run", "scan", "--", ...args]
  const env = {
    ...process.env,
    SCRAPER_ORCHESTRATOR_SKIP_ALL_EMAIL: "1",
  }

  return new Promise((resolve, reject) => {
    const out: Buffer[] = []
    const err: Buffer[] = []
    const child = spawn("pnpm", pnpmArgs, {
      cwd: repoRoot,
      env,
      shell: true,
    })
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
    const { code, stdout, stderr } = await runOrchestrator(cliArgs)
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
      { error: `לא ניתן להריץ pnpm/סריקה: ${msg}` },
      { status: 500 }
    )
  }
}
