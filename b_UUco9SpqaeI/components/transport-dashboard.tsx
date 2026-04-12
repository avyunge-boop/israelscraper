"use client"

import { useState, useMemo, useCallback, useEffect } from "react"
import { useSearchParams, useRouter, usePathname } from "next/navigation"
import { DashboardHeader } from "@/components/dashboard-header"
import { StatsBar } from "@/components/stats-bar"
import { ControlPanel } from "@/components/control-panel"
import { AlertCard } from "@/components/alert-card"
import { EmptyState } from "@/components/empty-state"
import { LogConsole } from "@/components/log-console"
import { StatsView } from "@/components/stats-view"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Database } from "lucide-react"
import { splitAlertsNewVsExisting } from "@/lib/alert-split"
import { consumeProxyScanStream } from "@/lib/proxy-scan-stream"
import {
  isScraperBridgeMissingError,
  runScrapeRemotePoll,
} from "@/lib/scraper-remote-poll"
import { transportAlertsToCsvString } from "@/lib/csv-export"
import { mergeAiSummariesWithLocalCache } from "@/lib/ai-summary-local-cache"
import type { AlertProvider, TransportAlert } from "@/lib/transport-alert"
import {
  busnearbyScanRoutesOnlyMessage,
  filterTabLabel,
  getDashboardUiBundle,
  parseDashboardLang,
  scanAllCompleteMessage,
  scanCompleteMessage,
  scanOrEmailError,
  type DashboardLang,
} from "@/lib/dashboard-i18n"

type FilterType = "all" | "busnearby" | AlertProvider

type ScanSourceTimestamp = {
  sourceId: string
  displayName?: string
  scrapedAt?: string
  success?: boolean
}

interface TransportAlertsResponse {
  alerts: TransportAlert[]
  meta: {
    lastUpdated: string
    count: number
    sourcesTried: string[]
    aiEnabled?: boolean
    quick?: boolean
    scanSourceTimestamps?: ScanSourceTimestamp[]
  }
}

/** גוף POST ל-/run-scrape עבור Bus Nearby (מסלולים בלבד, מוגבל למהירות). */
const BUSNEARBY_RUN_SCRAPE_BODY = {
  agency: "busnearby" as const,
  maxRoutes: 200,
}

/** כפתורי סריקה → מסנן לשליחת המייל */
const AGENCY_SCAN_MAP: Record<string, FilterType> = {
  busnearby: "busnearby",
  egged: "אגד",
  dan: "דן",
  kavim: "קווים",
  metropoline: "מטרופולין",
}

function formatLastUpdated(iso: string, lang: DashboardLang): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const locale = lang === "en" ? "en-IL" : "he-IL"
    return d.toLocaleDateString(locale, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  } catch {
    return iso
  }
}

function alertsMatchingFilter(
  list: TransportAlert[],
  filter: FilterType
): TransportAlert[] {
  if (filter === "all") return list
  if (filter === "busnearby") return list.filter((a) => a.dataSource === "busnearby")
  return list.filter((a) => a.provider === filter)
}

const FILTER_ORDER: FilterType[] = [
  "all",
  "busnearby",
  "אגד",
  "דן",
  "קווים",
  "מטרופולין",
  "אחר",
]

/** Prefer /api/scraper-bridge/config; if missing (404) use /api/health-check (scraperApiUrl / useRemoteScraper). */
async function resolveUseRemoteScraper(): Promise<boolean> {
  try {
    const cfgRes = await fetch("/api/scraper-bridge/config", {
      cache: "no-store",
    })
    if (cfgRes.ok) {
      const cfg = (await cfgRes.json()) as { useRemoteScraper?: boolean }
      if (cfg.useRemoteScraper === true) return true
    }
  } catch {
    /* */
  }
  try {
    const hRes = await fetch("/api/health-check", { cache: "no-store" })
    if (!hRes.ok) return false
    const h = (await hRes.json()) as {
      useRemoteScraper?: boolean
      scraperApiUrl?: string | null
    }
    if (h.useRemoteScraper === true) return true
    return typeof h.scraperApiUrl === "string" && h.scraperApiUrl.trim() !== ""
  } catch {
    return false
  }
}

export function TransportDashboard() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname() || "/"

  const lang = parseDashboardLang(searchParams.get("lang"))

  const setLang = useCallback(
    (next: DashboardLang) => {
      const p = new URLSearchParams(searchParams.toString())
      if (next === "en") {
        p.set("lang", "en")
      } else {
        p.delete("lang")
      }
      const q = p.toString()
      router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  const { ui, intervals } = useMemo(() => getDashboardUiBundle(lang), [lang])

  const [searchQuery, setSearchQuery] = useState("")
  const [activeFilter, setActiveFilter] = useState<FilterType>("all")
  /** מפתחות פעילים: מזהה סוכנות, "all", או "initBnDb" — כל כפתור נעול רק על עצמו. */
  const [scanningKeys, setScanningKeys] = useState<string[]>([])
  const addScanKey = useCallback((k: string) => {
    setScanningKeys((prev) => (prev.includes(k) ? prev : [...prev, k]))
  }, [])
  const removeScanKey = useCallback((k: string) => {
    setScanningKeys((prev) => prev.filter((x) => x !== k))
  }, [])
  const isScanningKey = useCallback(
    (k: string) => scanningKeys.includes(k),
    [scanningKeys]
  )
  const [scanInterval, setScanInterval] = useState("6")
  const [scanSourceTimestamps, setScanSourceTimestamps] = useState<
    ScanSourceTimestamp[]
  >([])

  const [alerts, setAlerts] = useState<TransportAlert[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [dataLastUpdated, setDataLastUpdated] = useState<string>(() =>
    new Date().toISOString()
  )

  const [recipientEmail, setRecipientEmail] = useState("")
  const [settingsSaveState, setSettingsSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle")

  const [deskTab, setDeskTab] = useState<"alerts" | "stats" | "ops">("alerts")
  const [scanLogs, setScanLogs] = useState<string[]>([])
  const [scanProgress, setScanProgress] = useState<{
    agency: string
    displayName: string
    current: number
    total: number
    alertsFound: number
  } | null>(null)
  const [healthOk, setHealthOk] = useState<boolean | null>(null)
  const [healthFailures, setHealthFailures] = useState<string[]>([])
  const [healthWarnings, setHealthWarnings] = useState<string[]>([])
  const [routesDatabaseOk, setRoutesDatabaseOk] = useState<boolean | null>(null)
  const [routesDbNeedsInit, setRoutesDbNeedsInit] = useState<boolean | null>(null)

  const [ephemeralBanner, setEphemeralBanner] = useState<{
    text: string
    tone: "default" | "destructive"
  } | null>(null)

  const showEphemeralBanner = useCallback(
    (text: string, tone: "default" | "destructive" = "default") => {
      setEphemeralBanner({ text, tone })
    },
    []
  )

  useEffect(() => {
    if (!ephemeralBanner) return
    const id = window.setTimeout(() => setEphemeralBanner(null), 3000)
    return () => window.clearTimeout(id)
  }, [ephemeralBanner])

  useEffect(() => {
    const fetchHealth = () => {
      fetch("/api/health-check")
        .then((r) => r.json())
        .then(
          (d: {
            healthy?: boolean
            failures?: string[]
            warnings?: string[]
            routesDatabaseOk?: boolean
            routesDbNeedsInit?: boolean
          }) => {
            setHealthOk(d.healthy === true)
            setHealthFailures(Array.isArray(d.failures) ? d.failures : [])
            setHealthWarnings(Array.isArray(d.warnings) ? d.warnings : [])
            setRoutesDatabaseOk(
              typeof d.routesDatabaseOk === "boolean" ? d.routesDatabaseOk : null
            )
            setRoutesDbNeedsInit(
              typeof d.routesDbNeedsInit === "boolean" ? d.routesDbNeedsInit : null
            )
          }
        )
        .catch(() => {
          setHealthOk(false)
          setHealthFailures(["Health check failed"])
          setHealthWarnings([])
          setRoutesDatabaseOk(false)
          setRoutesDbNeedsInit(true)
        })
    }
    fetchHealth()
    const t = window.setInterval(fetchHealth, 45_000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d: { recipientEmail?: string }) => {
        if (typeof d.recipientEmail === "string") setRecipientEmail(d.recipientEmail)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    try {
      const v = localStorage.getItem("dashboard-scan-interval-hours")
      if (v && v.trim()) setScanInterval(v.trim())
    } catch {
      /* */
    }
  }, [])

  const handleScanIntervalChange = useCallback((v: string) => {
    setScanInterval(v)
    try {
      localStorage.setItem("dashboard-scan-interval-hours", v)
    } catch {
      /* */
    }
  }, [])

  const appendScanLog = useCallback((line: string) => {
    const t = line.trimEnd()
    if (!t) return
    console.log("[appendScanLog]", t)
    setScanLogs((prev) => [...prev.slice(-3000), t])
  }, [])

  /**
   * טעינת התראות: קודם ?quick=1 (ללא AI / פעילות) — תצוגה מהירה; אחר כך מלא ברקע.
   * @param silent — אחרי סריקה: רק GET מלא (עם AI מקובץ).
   */
  const refetchAlerts = useCallback(
    (opts?: { silent?: boolean }): Promise<void> => {
      const applyPayload = (data: TransportAlertsResponse) => {
        const raw = Array.isArray(data.alerts) ? data.alerts : []
        const epoch = data.meta?.lastUpdated ?? new Date().toISOString()
        setAlerts(mergeAiSummariesWithLocalCache(raw, epoch))
        setDataLastUpdated(epoch)
        if (Array.isArray(data.meta?.scanSourceTimestamps)) {
          setScanSourceTimestamps(data.meta.scanSourceTimestamps)
        }
      }

      if (!opts?.silent) {
        setLoading(true)
      }
      setLoadError(null)

      const run = async () => {
        try {
          if (!opts?.silent) {
            const qres = await fetch("/api/transport-alerts?quick=1")
            if (!qres.ok) throw new Error(`HTTP ${qres.status}`)
            const qdata = (await qres.json()) as TransportAlertsResponse
            applyPayload(qdata)
            setLoading(false)
            void fetch("/api/transport-alerts")
              .then(async (res) => {
                if (!res.ok) return
                const data = (await res.json()) as TransportAlertsResponse
                applyPayload(data)
              })
              .catch(() => {})
          } else {
            const res = await fetch("/api/transport-alerts")
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = (await res.json()) as TransportAlertsResponse
            applyPayload(data)
          }
        } catch (e: unknown) {
          setLoadError(e instanceof Error ? e.message : "שגיאת טעינה")
          setAlerts([])
        } finally {
          if (!opts?.silent) setLoading(false)
        }
      }
      return run()
    },
    []
  )

  /** רענון אחרי סריקה: אימות מול GET /data/scan-export.json (פרוקסי) + מיזוג ב-transport-alerts. */
  const reloadCachedAlertsAfterScrape = useCallback(async () => {
    await fetch("/api/scraper-bridge/data/scan-export.json", {
      cache: "no-store",
    }).catch(() => {})
    await refetchAlerts({ silent: true })
  }, [refetchAlerts])

  /** בעת טעינת הדף — טעינת התראות ממטמון (GCS) דרך /api/transport-alerts; לא מפעיל סריקה. */
  useEffect(() => {
    void refetchAlerts()
  }, [refetchAlerts])

  const lastUpdated = useMemo(
    () => formatLastUpdated(dataLastUpdated, lang),
    [dataLastUpdated, lang]
  )

  const filteredAlerts = useMemo(() => {
    const byTab = alertsMatchingFilter(alerts, activeFilter)
    return byTab.filter((alert) => {
      if (!searchQuery) return true
      const query = searchQuery.toLowerCase()
      const matchesLine = alert.lineNumbers.some((line) =>
        line.toLowerCase().includes(query)
      )
      const matchesTitle = alert.title.toLowerCase().includes(query)
      const matchesContent = alert.fullContent.toLowerCase().includes(query)
      const matchesAi =
        (alert.aiSummary?.toLowerCase().includes(query) ?? false)
      const matchesEn =
        (alert.summaryEn?.toLowerCase().includes(query) ?? false)
      return (
        matchesLine ||
        matchesTitle ||
        matchesContent ||
        matchesAi ||
        matchesEn
      )
    })
  }, [searchQuery, activeFilter, alerts])

  const stats = useMemo(
    () => ({
      totalAlerts: alerts.length,
      newToday: alerts.filter((a) => a.isNew).length,
      duplicatesBlocked: 0,
      isOnline: !loadError && !loading,
    }),
    [alerts, loadError, loading]
  )

  const exportSlice = useMemo(
    () => alertsMatchingFilter(alerts, activeFilter),
    [alerts, activeFilter]
  )

  const exportButtonLabel = useMemo(() => {
    const scope = filterTabLabel(lang, activeFilter)
    return `${ui.exportCsvPrefix} ${scope} (${exportSlice.length})`
  }, [activeFilter, exportSlice.length, lang, ui.exportCsvPrefix])

  const runProxyScan = useCallback(
    async (
      body:
        | { agency: string; refresh?: boolean; maxRoutes?: number; fullScan?: boolean }
        | { all: true; refresh?: boolean },
      opts?: { logPrefix?: string }
    ) => {
      const p = opts?.logPrefix ? `[${opts.logPrefix}] ` : ""
      setDeskTab("ops")
      setScanLogs([])
      setScanProgress(null)

      const useRemote = await resolveUseRemoteScraper()

      if (useRemote) {
        try {
          const { ok, exitCode } = await runScrapeRemotePoll(body, {
            onLog: (text) => appendScanLog(`${p}${text.trimEnd()}`),
            onProgress: (pr) => {
              setScanProgress({
                agency: String(pr.agency ?? ""),
                displayName: String(pr.displayName ?? pr.agency ?? ""),
                current: Number(pr.current ?? 0),
                total: Number(pr.total ?? 0),
                alertsFound: Number(pr.alertsFound ?? 0),
              })
            },
          })
          setScanProgress(null)
          if (!ok) {
            throw new Error(`האורקסטרטור יצא עם קוד ${exitCode}`)
          }
          return
        } catch (e) {
          if (!isScraperBridgeMissingError(e)) throw e
          appendScanLog(
            `${p}scraper-bridge לא בפריסה — ממשיכים ב־/api/proxy-scan (עדיין דרך SCRAPER_API_URL בשרת אם מוגדר).`
          )
        }
      }

      await consumeProxyScanStream(body, {
        onLog: (text) => appendScanLog(`${p}${text.trimEnd()}`),
        onProgress: (pr) => {
          setScanProgress({
            agency: String(pr.agency ?? ""),
            displayName: String(pr.displayName ?? pr.agency ?? ""),
            current: Number(pr.current ?? 0),
            total: Number(pr.total ?? 0),
            alertsFound: Number(pr.alertsFound ?? 0),
          })
        },
      })
      setScanProgress(null)
    },
    [appendScanLog]
  )

  const sendReportAfterScan = useCallback(
    async (filter: FilterType, log?: (line: string) => void) => {
      log?.("📧 שולח מייל...")
      const to = recipientEmail.trim() || undefined
      const res = await fetch("/api/send-alerts-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter, to }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        error?: string
        sent?: number
        emailSkipped?: boolean
      }
      if (!res.ok) {
        throw new Error(data.error ?? res.statusText)
      }
      if (data.emailSkipped === true) {
        log?.("✅ מייל: אין התראות במסנן — דילוג על שליחה")
      } else {
        log?.(`✅ מייל נשלח (${String(data.sent ?? 0)} התראות)`)
      }
      return {
        sent: data.sent ?? 0,
        emailSkipped: data.emailSkipped === true,
      }
    },
    [recipientEmail]
  )

  const handleScanAgency = useCallback(
    async (agency: string) => {
      const filter = AGENCY_SCAN_MAP[agency] ?? "all"
      addScanKey(agency)
      try {
        const runBody =
          agency === "busnearby" ? BUSNEARBY_RUN_SCRAPE_BODY : { agency }
        await runProxyScan(runBody, { logPrefix: agency })
        await reloadCachedAlertsAfterScrape()
        const { sent, emailSkipped } = await sendReportAfterScan(
          filter,
          appendScanLog
        )
        const scope = filterTabLabel(lang, filter)
        if (agency === "busnearby") {
          showEphemeralBanner(
            `${busnearbyScanRoutesOnlyMessage(lang)} · ${scanCompleteMessage(lang, sent, scope, { emailSkipped })}`
          )
          return
        }
        showEphemeralBanner(
          scanCompleteMessage(lang, sent, scope, { emailSkipped })
        )
      } catch (e) {
        showEphemeralBanner(
          e instanceof Error ? e.message : scanOrEmailError(lang),
          "destructive"
        )
      } finally {
        removeScanKey(agency)
      }
    },
    [
      addScanKey,
      lang,
      reloadCachedAlertsAfterScrape,
      removeScanKey,
      runProxyScan,
      sendReportAfterScan,
      showEphemeralBanner,
      appendScanLog,
    ]
  )

  const handleDeepScanBusnearby = useCallback(async () => {
    addScanKey("busnearbyDeep")
    try {
      await runProxyScan(
        {
          agency: "busnearby",
          maxRoutes: 200,
          fullScan: true,
        },
        { logPrefix: "bn-deep" }
      )
      await reloadCachedAlertsAfterScrape()
      const { sent, emailSkipped } = await sendReportAfterScan(
        "busnearby",
        appendScanLog
      )
      const scope = filterTabLabel(lang, "busnearby")
      showEphemeralBanner(
        `סריקה מעמיקה · ${busnearbyScanRoutesOnlyMessage(lang)} · ${scanCompleteMessage(lang, sent, scope, { emailSkipped })}`
      )
    } catch (e) {
      showEphemeralBanner(
        e instanceof Error ? e.message : scanOrEmailError(lang),
        "destructive"
      )
    } finally {
      removeScanKey("busnearbyDeep")
    }
  }, [
    addScanKey,
    lang,
    reloadCachedAlertsAfterScrape,
    removeScanKey,
    runProxyScan,
    sendReportAfterScan,
    showEphemeralBanner,
    appendScanLog,
  ])

  const handleInitBusnearbyRoutesDb = useCallback(async () => {
    addScanKey("initBnDb")
    try {
      await runProxyScan(
        { ...BUSNEARBY_RUN_SCRAPE_BODY, refresh: true },
        { logPrefix: "initBnDb" }
      )
      await reloadCachedAlertsAfterScrape()
      const { sent, emailSkipped } = await sendReportAfterScan(
        "busnearby",
        appendScanLog
      )
      const scope = filterTabLabel(lang, "busnearby")
      showEphemeralBanner(
        `${busnearbyScanRoutesOnlyMessage(lang)} · ${scanCompleteMessage(lang, sent, scope, { emailSkipped })}`
      )
    } catch (e) {
      showEphemeralBanner(
        e instanceof Error ? e.message : scanOrEmailError(lang),
        "destructive"
      )
    } finally {
      removeScanKey("initBnDb")
    }
  }, [
    addScanKey,
    lang,
    reloadCachedAlertsAfterScrape,
    removeScanKey,
    runProxyScan,
    sendReportAfterScan,
    showEphemeralBanner,
    appendScanLog,
  ])

  const handleScanAll = useCallback(async () => {
    addScanKey("all")
    try {
      await runProxyScan({ all: true }, { logPrefix: "all" })
      await reloadCachedAlertsAfterScrape()
      const { sent, emailSkipped } = await sendReportAfterScan(
        "all",
        appendScanLog
      )
      showEphemeralBanner(scanAllCompleteMessage(lang, sent, { emailSkipped }))
    } catch (e) {
      showEphemeralBanner(
        e instanceof Error ? e.message : scanOrEmailError(lang),
        "destructive"
      )
    } finally {
      removeScanKey("all")
    }
  }, [
    addScanKey,
    lang,
    reloadCachedAlertsAfterScrape,
    removeScanKey,
    runProxyScan,
    sendReportAfterScan,
    showEphemeralBanner,
    appendScanLog,
  ])

  const handleExport = useCallback(() => {
    const csv = transportAlertsToCsvString(exportSlice)
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    const slug = filterTabLabel(lang, activeFilter).replace(/\s+/g, "-")
    a.download = `alerts-${slug}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }, [exportSlice, activeFilter, lang])

  const handleSaveRecipient = useCallback(() => {
    setSettingsSaveState("saving")
    fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipientEmail }),
    })
      .then(async (r) => {
        if (!r.ok) {
          const j = (await r.json()) as { error?: string }
          throw new Error(j.error ?? r.statusText)
        }
        setSettingsSaveState("saved")
        setTimeout(() => setSettingsSaveState("idle"), 2500)
      })
      .catch(() => {
        setSettingsSaveState("error")
        setTimeout(() => setSettingsSaveState("idle"), 3000)
      })
  }, [recipientEmail])

  const { newToday: filteredNew, existing: filteredExisting } = useMemo(
    () => splitAlertsNewVsExisting(filteredAlerts),
    [filteredAlerts]
  )

  const filters = useMemo(
    () =>
      FILTER_ORDER.map((value) => ({
        value,
        label: filterTabLabel(lang, value),
      })),
    [lang]
  )

  const pageDir = lang === "en" ? "ltr" : "rtl"

  const scanStatusLines = useMemo(() => {
    const hours = Number(scanInterval)
    const h = Number.isFinite(hours) && hours > 0 ? hours : 6
    const times = scanSourceTimestamps
      .map((s) => {
        const t = s.scrapedAt ? Date.parse(s.scrapedAt) : NaN
        return Number.isFinite(t) ? t : 0
      })
      .filter((t) => t > 0)
    const lastMs = times.length > 0 ? Math.max(...times) : NaN
    const nextMs = Number.isFinite(lastMs) ? lastMs + h * 3_600_000 : NaN
    const fmt = (ms: number) =>
      Number.isFinite(ms)
        ? formatLastUpdated(new Date(ms).toISOString(), lang)
        : "—"
    const header =
      lang === "en"
        ? [
            `Auto-scan interval (saved in this browser): every ${String(h)} h`,
            `No server cron is wired to this dropdown — times below are estimates.`,
            `Estimated next run (last source time + interval): ${fmt(nextMs)}`,
            "Last scrape per agency (from scan-export):",
          ]
        : [
            `מרווח סריקה אוטומטית (נשמר בדפדפן): כל ${String(h)} שעות`,
            `אין כרגע קישור ל-Cron בענן — השדה להגדרה בלבד; השעות להערכה בלבד.`,
            `הרצה משוערת הבאה (אחרון + מרווח): ${fmt(nextMs)}`,
            "סריקה אחרונה לפי מקור (מ-scan-export):",
          ]
    const rows = scanSourceTimestamps.map((s) => {
      const ok = s.success !== false
      const st = s.scrapedAt ? formatLastUpdated(s.scrapedAt, lang) : "—"
      return `  • ${s.sourceId}${s.displayName ? ` (${s.displayName})` : ""} — ${st}${ok ? "" : " (failed)"}`
    })
    return [...header, ...rows]
  }, [scanSourceTimestamps, scanInterval, lang])

  return (
    <div className="min-h-screen bg-background" dir={pageDir}>
      {ephemeralBanner && (
        <div
          className="fixed top-4 left-1/2 z-[100] w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 px-1"
          role="status"
          aria-live="polite"
        >
          <Alert
            variant={
              ephemeralBanner.tone === "destructive" ? "destructive" : "default"
            }
            className={
              ephemeralBanner.tone === "destructive"
                ? "shadow-md"
                : "border-border/80 bg-muted/90 text-foreground shadow-md backdrop-blur-sm"
            }
          >
            <AlertDescription className="text-sm leading-snug">
              {ephemeralBanner.text}
            </AlertDescription>
          </Alert>
        </div>
      )}
      <DashboardHeader
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        lastUpdated={lastUpdated}
        lang={lang}
        ui={ui}
        onLanguageChange={setLang}
        healthOk={healthOk}
        healthFailures={healthFailures}
        healthWarnings={healthWarnings}
      />

      <main className="container mx-auto px-4 md:px-8 py-6 space-y-6">
        {loadError && (
          <p className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {ui.loadErrorPrefix} {loadError}. {ui.loadErrorSuffix}
          </p>
        )}
        {routesDbNeedsInit === true && (
          <div className="flex justify-center">
            <Card className="w-full max-w-2xl border-amber-500/40 shadow-sm">
              <CardContent className="pt-6">
                <Alert variant="default" className="border-amber-500/50 bg-amber-500/5">
                  <Database className="text-amber-700 dark:text-amber-400" />
                  <AlertTitle className="text-amber-950 dark:text-amber-100">
                    {ui.routesDbMissingTitle}
                  </AlertTitle>
                  <AlertDescription className="text-amber-950/80 dark:text-amber-50/90">
                    <p className="mb-4 max-w-prose">{ui.routesDbMissingDescription}</p>
                    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-center">
                      <Button
                        type="button"
                        onClick={() => setDeskTab("ops")}
                        className="w-full sm:w-auto"
                      >
                        {ui.routesDbOpenOperations}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setDeskTab("alerts")}
                        className="w-full sm:w-auto border-amber-600/40"
                      >
                        {ui.routesDbOpenAlertsControls}
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              </CardContent>
            </Card>
          </div>
        )}
        {loading && (
          <p className="text-sm text-muted-foreground">{ui.loadingAlerts}</p>
        )}

        <Tabs
          value={deskTab}
          onValueChange={(v) => setDeskTab(v as "alerts" | "stats" | "ops")}
          className="space-y-4"
        >
          <TabsList className="w-full justify-start flex-wrap h-auto bg-muted/50 p-1">
            <TabsTrigger value="alerts">{ui.tabAlerts}</TabsTrigger>
            <TabsTrigger value="stats">{ui.tabStats}</TabsTrigger>
            <TabsTrigger value="ops">{ui.tabOperations}</TabsTrigger>
          </TabsList>
          <TabsContent value="stats" className="mt-4">
            <StatsView ui={ui} />
          </TabsContent>
          <TabsContent value="ops" className="mt-4 space-y-4" forceMount>
            <Card className="border-border/60">
              <CardHeader className="py-3 pb-2">
                <CardTitle className="text-sm font-semibold">
                  {lang === "en" ? "Scan schedule & last run" : "סטטוס סריקות ולוח זמנים"}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <pre
                  className="max-h-40 overflow-y-auto rounded-md bg-muted/40 p-3 text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-words font-mono"
                  dir="ltr"
                >
                  {scanStatusLines.join("\n")}
                </pre>
              </CardContent>
            </Card>
            <LogConsole
              lines={scanLogs}
              title={ui.logConsoleTitle}
              emptyHint={ui.logConsoleEmpty}
            />
          </TabsContent>
          <TabsContent value="alerts" className="mt-4 space-y-6">
        <StatsBar {...stats} ui={ui} />

        <ControlPanel
          onScanAgency={handleScanAgency}
          onDeepScanBusnearby={handleDeepScanBusnearby}
          onScanAll={handleScanAll}
          onInitBusnearbyRoutesDb={handleInitBusnearbyRoutesDb}
          isScanningKey={isScanningKey}
          scanProgress={scanProgress}
          scanInterval={scanInterval}
          onIntervalChange={handleScanIntervalChange}
          onExport={handleExport}
          exportButtonLabel={exportButtonLabel}
          recipientEmail={recipientEmail}
          onRecipientEmailChange={setRecipientEmail}
          onSaveRecipient={handleSaveRecipient}
          settingsSaveState={settingsSaveState}
          ui={ui}
          intervals={intervals}
        />

        <Tabs value={activeFilter} onValueChange={(v) => setActiveFilter(v as FilterType)}>
          <TabsList className="w-full justify-start bg-muted/50 p-1 h-auto flex-wrap">
            {filters.map((filter) => (
              <TabsTrigger
                key={filter.value}
                value={filter.value}
                className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground px-4 py-2"
              >
                {filter.label}
                {filter.value !== "all" && (
                  <span className="ms-2 text-xs opacity-70">
                    (
                    {filter.value === "busnearby"
                      ? alerts.filter((a) => a.dataSource === "busnearby").length
                      : alerts.filter((a) => a.provider === filter.value).length}
                    )
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={activeFilter} className="mt-4">
            {loading && alerts.length === 0 ? (
              <p className="py-12 text-center text-muted-foreground">{ui.loading}</p>
            ) : filteredAlerts.length === 0 ? (
              <EmptyState ui={ui} />
            ) : (
              <div className="space-y-8">
                {filteredNew.length > 0 && (
                  <section>
                    <h2 className="text-lg font-semibold mb-3 text-foreground">
                      {ui.sectionNewAlerts}
                    </h2>
                    <div className="grid w-full grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
                      {filteredNew.map((alert) => (
                        <AlertCard key={alert.id} alert={alert} ui={ui} />
                      ))}
                    </div>
                  </section>
                )}
                {filteredExisting.length > 0 && (
                  <section>
                    <h2 className="text-lg font-semibold mb-3 text-muted-foreground">
                      {ui.sectionExistingAlerts}
                    </h2>
                    <div className="grid w-full grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
                      {filteredExisting.map((alert) => (
                        <AlertCard key={alert.id} alert={alert} ui={ui} />
                      ))}
                    </div>
                  </section>
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}
