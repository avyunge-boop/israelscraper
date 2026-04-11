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
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Database } from "lucide-react"
import { splitAlertsNewVsExisting } from "@/lib/alert-split"
import { consumeProxyScanStream } from "@/lib/proxy-scan-stream"
import { runScrapeRemotePoll } from "@/lib/scraper-remote-poll"
import { transportAlertsToCsvString } from "@/lib/csv-export"
import type { AlertProvider, TransportAlert } from "@/lib/transport-alert"
import {
  filterTabLabel,
  getDashboardUiBundle,
  parseDashboardLang,
  scanCompleteMessage,
  scanOrEmailError,
  type DashboardLang,
} from "@/lib/dashboard-i18n"
import { mergeAiSummariesWithLocalCache } from "@/lib/ai-summary-local-cache"

type FilterType = "all" | "busnearby" | AlertProvider

interface TransportAlertsResponse {
  alerts: TransportAlert[]
  meta: {
    lastUpdated: string
    count: number
    sourcesTried: string[]
    aiEnabled?: boolean
  }
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
  const [scanningAgency, setScanningAgency] = useState<string | null>(null)
  const [scanInterval, setScanInterval] = useState("6")

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
  const [routesDatabaseOk, setRoutesDatabaseOk] = useState<boolean | null>(null)

  const [toast, setToast] = useState<{
    text: string
    tone: "default" | "destructive"
  } | null>(null)

  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(null), 4000)
    return () => window.clearTimeout(id)
  }, [toast])

  const showToast = useCallback(
    (text: string, tone: "default" | "destructive" = "default") => {
      setToast({ text, tone })
    },
    []
  )

  useEffect(() => {
    const fetchHealth = () => {
      fetch("/api/health-check")
        .then((r) => r.json())
        .then(
          (d: {
            healthy?: boolean
            failures?: string[]
            routesDatabaseOk?: boolean
          }) => {
            setHealthOk(d.healthy === true)
            setHealthFailures(Array.isArray(d.failures) ? d.failures : [])
            setRoutesDatabaseOk(
              typeof d.routesDatabaseOk === "boolean" ? d.routesDatabaseOk : null
            )
          }
        )
        .catch(() => {
          setHealthOk(false)
          setHealthFailures(["Health check failed"])
          setRoutesDatabaseOk(false)
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

  const refetchAlerts = useCallback((opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true)
    setLoadError(null)
    return fetch("/api/transport-alerts")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<TransportAlertsResponse>
      })
      .then((data) => {
        const raw = Array.isArray(data.alerts) ? data.alerts : []
        const epoch = data.meta?.lastUpdated ?? new Date().toISOString()
        setDataLastUpdated(epoch)
        setAlerts(mergeAiSummariesWithLocalCache(raw, epoch))
      })
      .catch((e: unknown) => {
        setLoadError(e instanceof Error ? e.message : "שגיאת טעינה")
        setAlerts([])
      })
      .finally(() => {
        if (!opts?.silent) setLoading(false)
      })
  }, [])

  /** רק מטמון GCS: קודם GET /data/scan-export.json (פרוקסי), אחר כך מיזוג בשרת — ללא סריקה. */
  const reloadCachedScanExportOnly = useCallback(async () => {
    await fetch("/api/scraper-bridge/data/scan-export.json", {
      cache: "no-store",
    }).catch(() => {})
    await refetchAlerts({ silent: true })
  }, [refetchAlerts])

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

  /**
   * בפרודקשן (SCRAPER_API_URL / default): POST /run-scrape דרך bridge + polling /status.
   * מקומית: SSE מ־proxy-scan + pnpm orchestrator.
   */
  const runProxyScan = useCallback(
    async (
      body:
        | { agency: string; refresh?: boolean }
        | { all: true; refresh?: boolean }
    ) => {
      setDeskTab("ops")
      setScanLogs([])
      setScanProgress(null)

      const cfgRes = await fetch("/api/scraper-bridge/config", { cache: "no-store" })
      const cfg = (await cfgRes.json().catch(() => ({}))) as {
        useRemoteScraper?: boolean
      }

      if (cfg.useRemoteScraper === true) {
        const { ok, exitCode } = await runScrapeRemotePoll(body, {
          onLog: (text) =>
            setScanLogs((prev) => [...prev.slice(-500), text.trimEnd()]),
          onProgress: (p) => {
            setScanProgress({
              agency: String(p.agency ?? ""),
              displayName: String(p.displayName ?? p.agency ?? ""),
              current: Number(p.current ?? 0),
              total: Number(p.total ?? 0),
              alertsFound: Number(p.alertsFound ?? 0),
            })
          },
        })
        setScanProgress(null)
        if (!ok) {
          throw new Error(`האורקסטרטור יצא עם קוד ${exitCode}`)
        }
        return
      }

      await consumeProxyScanStream(body, {
        onLog: (text) =>
          setScanLogs((prev) => [...prev.slice(-500), text.trimEnd()]),
        onProgress: (p) => {
          setScanProgress({
            agency: String(p.agency ?? ""),
            displayName: String(p.displayName ?? p.agency ?? ""),
            current: Number(p.current ?? 0),
            total: Number(p.total ?? 0),
            alertsFound: Number(p.alertsFound ?? 0),
          })
        },
      })
      setScanProgress(null)
    },
    []
  )

  const sendReportAfterScan = useCallback(
    async (filter: FilterType) => {
      const to = recipientEmail.trim() || undefined
      const res = await fetch("/api/send-alerts-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter, to }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        error?: string
        sent?: number
      }
      if (!res.ok) {
        throw new Error(data.error ?? res.statusText)
      }
      return data.sent ?? 0
    },
    [recipientEmail]
  )

  const handleScanAgency = useCallback(
    async (agency: string) => {
      const filter = AGENCY_SCAN_MAP[agency] ?? "all"
      setScanningAgency(agency)
      try {
        const runBody =
          agency === "busnearby"
            ? { agency: "busnearby" as const, refresh: true as const }
            : { agency }
        await runProxyScan(runBody)
        await reloadCachedScanExportOnly()
        const n = await sendReportAfterScan(filter)
        const scope = filterTabLabel(lang, filter)
        showToast(scanCompleteMessage(lang, n, scope))
      } catch (e) {
        showToast(
          e instanceof Error ? e.message : scanOrEmailError(lang),
          "destructive"
        )
      } finally {
        setScanningAgency(null)
      }
    },
    [
      lang,
      reloadCachedScanExportOnly,
      runProxyScan,
      sendReportAfterScan,
      showToast,
    ]
  )

  const handleInitBusnearbyRoutesDb = useCallback(async () => {
    setScanningAgency("initBnDb")
    try {
      await runProxyScan({ agency: "busnearby", refresh: true })
      await reloadCachedScanExportOnly()
      const n = await sendReportAfterScan("busnearby")
      const scope = filterTabLabel(lang, "busnearby")
      showToast(scanCompleteMessage(lang, n, scope))
    } catch (e) {
      showToast(
        e instanceof Error ? e.message : scanOrEmailError(lang),
        "destructive"
      )
    } finally {
      setScanningAgency(null)
    }
  }, [
    lang,
    reloadCachedScanExportOnly,
    runProxyScan,
    sendReportAfterScan,
    showToast,
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

  return (
    <div className="min-h-screen bg-background" dir={pageDir}>
      {toast && (
        <div
          className="fixed top-4 left-1/2 z-[100] w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 px-1"
          role="status"
          aria-live="polite"
        >
          <Alert
            variant={toast.tone === "destructive" ? "destructive" : "default"}
            className={
              toast.tone === "destructive"
                ? "shadow-md"
                : "border-border/80 bg-muted/90 shadow-md backdrop-blur-sm"
            }
          >
            <AlertDescription className="text-sm leading-snug">
              {toast.text}
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
      />

      <main className="container mx-auto px-4 md:px-8 py-6 space-y-6">
        {loadError && (
          <p className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {ui.loadErrorPrefix} {loadError}. {ui.loadErrorSuffix}
          </p>
        )}
        {routesDatabaseOk === false && (
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
          <TabsContent value="ops" className="mt-4" forceMount>
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
          onInitBusnearbyRoutesDb={handleInitBusnearbyRoutesDb}
          scanningAgency={scanningAgency}
          scanProgress={scanningAgency ? scanProgress : null}
          scanInterval={scanInterval}
          onIntervalChange={setScanInterval}
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
