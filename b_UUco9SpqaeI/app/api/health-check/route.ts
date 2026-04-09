import { existsSync, readFileSync } from "fs"
import path from "path"
import { NextResponse } from "next/server"

import {
  resolveCanonicalDataDir,
  resolveOrchestratorRepoRoot,
} from "@/lib/server/workspace-paths"

export const dynamic = "force-dynamic"

function hasBusAlertsJson(dataDir: string): boolean {
  const p = path.join(dataDir, "bus-alerts.json")
  if (!existsSync(p)) return false
  try {
    const raw = readFileSync(p, "utf-8").trim()
    if (!raw) return false
    const j = JSON.parse(raw) as { alerts?: unknown[] }
    return Array.isArray(j.alerts) && j.alerts.length > 0
  } catch {
    return false
  }
}

function hasEggedAlertsJson(dataDir: string): boolean {
  const p = path.join(dataDir, "egged-alerts.json")
  if (!existsSync(p)) return false
  try {
    const raw = readFileSync(p, "utf-8").trim()
    if (!raw) return false
    const j = JSON.parse(raw) as { alerts?: Record<string, unknown> }
    const bag = j.alerts
    if (!bag || typeof bag !== "object") return false
    return Object.keys(bag).length > 0
  } catch {
    return false
  }
}

function scanExportHasAlerts(dataDir: string): boolean {
  const p = path.join(dataDir, "scan-export.json")
  if (!existsSync(p)) return false
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as {
      sources?: Array<{ alerts?: unknown[] }>
    }
    return (raw.sources ?? []).some(
      (s) => Array.isArray(s.alerts) && s.alerts.length > 0
    )
  } catch {
    return false
  }
}

export async function GET() {
  const repoRoot = resolveOrchestratorRepoRoot()
  const dataDir = resolveCanonicalDataDir()
  const routesPath = path.join(dataDir, "routes-database.json")
  const scanPath = path.join(dataDir, "scan-export.json")

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

  const cachedAlertsOk =
    hasBusAlertsJson(dataDir) ||
    hasEggedAlertsJson(dataDir) ||
    scanExportHasAlerts(dataDir)

  const canRecoverOrScrape = routesOk || cachedAlertsOk
  const routesDbNeedsInit = !canRecoverOrScrape

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
  if (routesDbNeedsInit) {
    failures.push(
      "No routes DB and no cached alerts — run Bus Nearby init or a scan"
    )
  }

  const warnings: string[] = []
  if (!routesOk && cachedAlertsOk) {
    warnings.push(
      "routes-database.json missing or empty — run Bus Nearby refresh to rebuild routes list"
    )
  }
  if (!existsSync(scanPath) && canRecoverOrScrape) {
    warnings.push(
      "scan-export.json missing — optional; run full scan to create merged export"
    )
  }

  const healthy =
    failures.length === 0 && groqOk && canRecoverOrScrape

  return NextResponse.json({
    healthy,
    groqOk,
    routesDatabaseOk: routesOk,
    routesDbNeedsInit,
    cachedAlertsOk,
    canRecoverOrScrape,
    scanExportExists: existsSync(scanPath),
    agencies,
    failures,
    warnings,
    dataRoot: dataDir,
    repoRoot,
  })
}
