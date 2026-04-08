import { existsSync, readFileSync } from "fs"
import path from "path"
import { NextResponse } from "next/server"

import { resolveOrchestratorRepoRoot } from "@/lib/server/workspace-paths"

export const dynamic = "force-dynamic"

export async function GET() {
  const root = resolveOrchestratorRepoRoot()
  const routesPath = path.join(root, "data", "routes-database.json")
  const scanPath = path.join(root, "data", "scan-export.json")

  const routesOk =
    existsSync(routesPath) &&
    (() => {
      try {
        const raw = readFileSync(routesPath, "utf-8").trim()
        if (!raw) return false
        const j = JSON.parse(raw) as { routes?: unknown[] }
        return Array.isArray(j.routes) && j.routes.length > 0
      } catch {
        return false
      }
    })()

  const key = process.env.GROQ_API_KEY?.trim()
  let groqOk = !key
  if (key) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.GROQ_MODEL?.trim() || "llama-3.1-8b-instant",
          max_tokens: 8,
          messages: [{ role: "user", content: "ping" }],
        }),
      })
      groqOk = res.ok
    } catch {
      groqOk = false
    }
  }

  const agencies: Record<string, { lastScrapedAt: string | null; ok: boolean }> =
    {}
  try {
    if (existsSync(scanPath)) {
      const raw = JSON.parse(readFileSync(scanPath, "utf-8")) as {
        sources?: Array<{
          sourceId: string
          success?: boolean
          scrapedAt?: string
        }>
      }
      for (const s of raw.sources ?? []) {
        agencies[s.sourceId] = {
          lastScrapedAt: s.scrapedAt ?? null,
          ok: s.success !== false,
        }
      }
    }
  } catch {
    /* */
  }

  const failures: string[] = []
  if (key && !groqOk) failures.push("Groq API unreachable or error")
  if (!routesOk) failures.push("routes-database.json missing or empty")
  if (!existsSync(scanPath)) failures.push("scan-export.json missing")

  const healthy = failures.length === 0 && groqOk && routesOk && existsSync(scanPath)

  return NextResponse.json({
    healthy,
    groqOk,
    routesDatabaseOk: routesOk,
    scanExportExists: existsSync(scanPath),
    agencies,
    failures,
    dataRoot: path.join(root, "data"),
  })
}
