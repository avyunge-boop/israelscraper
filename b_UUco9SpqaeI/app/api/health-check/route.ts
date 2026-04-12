import { existsSync, readFileSync } from "fs"
import path from "path"
import { NextResponse } from "next/server"

import {
  fetchScraperDataJson,
  getScraperApiBaseUrl,
} from "@/lib/server/scraper-api"
import { ensureDashboardEnvLoaded } from "@/lib/server/env-bootstrap"
import {
  resolveCanonicalDataDir,
  resolveOrchestratorRepoRoot,
} from "@/lib/server/workspace-paths"

export const dynamic = "force-dynamic"

async function readDataJson(fileName: string): Promise<unknown | null> {
  if (getScraperApiBaseUrl()) {
    const j = await fetchScraperDataJson(fileName)
    if (j !== null) return j
  }
  const p = path.join(resolveCanonicalDataDir(), fileName)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as unknown
  } catch {
    return null
  }
}

function hasBusAlertsJson(j: unknown): boolean {
  if (!j || typeof j !== "object") return false
  const alerts = (j as { alerts?: unknown[] }).alerts
  return Array.isArray(alerts) && alerts.length > 0
}

function hasEggedAlertsJson(j: unknown): boolean {
  if (!j || typeof j !== "object") return false
  const bag = (j as { alerts?: Record<string, unknown> }).alerts
  if (!bag || typeof bag !== "object") return false
  return Object.keys(bag).length > 0
}

function scanExportHasAlerts(j: unknown): boolean {
  if (!j || typeof j !== "object") return false
  const sources = (j as { sources?: Array<{ alerts?: unknown[] }> }).sources
  return (sources ?? []).some(
    (s) => Array.isArray(s.alerts) && s.alerts.length > 0
  )
}

function routesDatabaseOk(j: unknown): boolean {
  if (!j || typeof j !== "object") return false
  const routes = (j as { routes?: unknown[] }).routes
  return Array.isArray(routes) && routes.length > 0
}

export async function GET() {
  ensureDashboardEnvLoaded()
  const repoRoot = resolveOrchestratorRepoRoot()
  const dataDir = resolveCanonicalDataDir()

  const routesJ = await readDataJson("routes-database.json")
  const routesOk = routesDatabaseOk(routesJ)

  const busJ = await readDataJson("bus-alerts.json")
  const eggedJ = await readDataJson("egged-alerts.json")
  const scanJ = await readDataJson("scan-export.json")

  const cachedAlertsOk =
    hasBusAlertsJson(busJ) ||
    hasEggedAlertsJson(eggedJ) ||
    scanExportHasAlerts(scanJ)

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
    if (scanJ && typeof scanJ === "object") {
      const raw = scanJ as {
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

  const scanExportExists =
    scanJ !== null ||
    existsSync(path.join(dataDir, "scan-export.json"))

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
  if (!scanJ && canRecoverOrScrape) {
    warnings.push(
      "scan-export.json missing — optional; run any completed scan from the dashboard (one agency or “all”) so the orchestrator can write the merged export"
    )
  }

  const healthy =
    failures.length === 0 && groqOk && canRecoverOrScrape

  const scraperApiUrl = getScraperApiBaseUrl() ?? null

  return NextResponse.json({
    healthy,
    groqOk,
    routesDatabaseOk: routesOk,
    routesDbNeedsInit,
    cachedAlertsOk,
    canRecoverOrScrape,
    scanExportExists,
    agencies,
    failures,
    warnings,
    dataRoot: dataDir,
    repoRoot,
    scraperApiUrl,
    /** Same as /api/scraper-bridge/config — lets UI pick remote poll if config route is missing on an old revision. */
    useRemoteScraper: Boolean(scraperApiUrl),
  })
}
