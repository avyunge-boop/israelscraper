"use client"

import { Play, RefreshCw, Download, Clock, Mail, Save, Database } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import type { DashboardUiStrings, IntervalOption } from "@/lib/dashboard-i18n"

export type ScanProgressPayload = {
  agency: string
  displayName: string
  current: number
  total: number
  alertsFound: number
} | null

interface ControlPanelProps {
  onScanAgency: (agency: string) => void
  onScanAll: () => void
  onInitBusnearbyRoutesDb: () => void
  isScanning: boolean
  scanningAgency: string | null
  scanProgress: ScanProgressPayload
  scanInterval: string
  onIntervalChange: (interval: string) => void
  onExport: () => void
  exportButtonLabel: string
  recipientEmail: string
  onRecipientEmailChange: (value: string) => void
  onSaveRecipient: () => void
  settingsSaveState: "idle" | "saving" | "saved" | "error"
  ui: DashboardUiStrings
  intervals: IntervalOption[]
}

const agencies = [
  { id: "busnearby", name: "Bus Nearby", color: "bg-violet-500" },
  { id: "egged", name: "אגד", color: "bg-emerald-500" },
  { id: "dan", name: "דן", color: "bg-sky-500" },
  { id: "kavim", name: "קווים", color: "bg-amber-500" },
  { id: "metropoline", name: "מטרופולין", color: "bg-rose-500" },
]

export function ControlPanel({
  onScanAgency,
  onScanAll,
  onInitBusnearbyRoutesDb,
  isScanning,
  scanningAgency,
  scanProgress,
  scanInterval,
  onIntervalChange,
  onExport,
  exportButtonLabel,
  recipientEmail,
  onRecipientEmailChange,
  onSaveRecipient,
  settingsSaveState,
  ui,
  intervals,
}: ControlPanelProps) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg font-bold">{ui.manualActions}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4" aria-busy={isScanning}>
          <div className="flex flex-wrap gap-2 justify-stretch sm:justify-start">
            {agencies.map((agency) => (
              <Button
                key={agency.id}
                variant="outline"
                onClick={() => onScanAgency(agency.id)}
                disabled={isScanning}
                aria-busy={scanningAgency === agency.id}
                title={ui.scanNow}
                className="relative h-12 min-w-[9rem] shrink-0 flex-1 basis-[calc(50%-0.25rem)] sm:flex-none sm:basis-auto border-border hover:bg-muted"
              >
                <span
                  className={`absolute start-2 top-1/2 -translate-y-1/2 size-2 rounded-full shrink-0 ${agency.color}`}
                />
                <span className="me-1 truncate">{agency.name}</span>
                {(scanningAgency === agency.id ||
                  (scanningAgency === "all" &&
                    scanProgress?.agency === agency.id)) && (
                  <span className="text-[10px] font-medium text-muted-foreground tabular-nums shrink-0">
                    {scanProgress?.agency === agency.id
                      ? scanProgress.alertsFound
                      : "…"}
                  </span>
                )}
                {scanningAgency === agency.id ||
                (scanningAgency === "all" &&
                  scanProgress?.agency === agency.id) ? (
                  <Spinner className="size-4 shrink-0" />
                ) : (
                  <Play className="size-4 fill-current shrink-0" />
                )}
              </Button>
            ))}
          </div>
          {scanProgress && isScanning && (
            <p className="text-[11px] text-muted-foreground text-center w-full max-w-xl mx-auto" dir="ltr">
              {scanProgress.displayName} · {ui.scanProgressLabel}{" "}
              {scanProgress.current}/{scanProgress.total} · Found: {scanProgress.alertsFound}{" "}
              alerts
            </p>
          )}
          <div className="flex flex-col items-center gap-2 w-full pt-1">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="w-full max-w-md gap-2 text-xs border-dashed"
              disabled={isScanning}
              aria-busy={scanningAgency === "initBnDb"}
              title={ui.initRoutesDbHint}
              onClick={onInitBusnearbyRoutesDb}
            >
              {scanningAgency === "initBnDb" ? (
                <Spinner className="size-4 shrink-0" />
              ) : (
                <Database className="size-4 shrink-0" />
              )}
              {scanningAgency === "initBnDb" ? ui.initRoutesDbRunning : ui.initRoutesDb}
            </Button>
          </div>
          <div className="flex w-full justify-center pt-0.5">
            <Button
            onClick={onScanAll}
            disabled={isScanning}
            aria-busy={isScanning}
            className="w-full max-w-md mx-auto bg-primary text-primary-foreground hover:bg-primary/90 h-12 shrink-0"
          >
            {isScanning ? (
              <>
                <Spinner className="size-5 me-2 shrink-0" />
                {scanningAgency === "all" ? ui.scanningAll : ui.scanningInProgress}
              </>
            ) : (
              <>
                <RefreshCw className="size-5 me-2 shrink-0" />
                {ui.scanAll}
              </>
            )}
          </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/60">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg font-bold">{ui.automationSettings}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="recipient-email" className="flex items-center gap-2 text-sm font-medium">
              <Mail className="size-4 text-muted-foreground shrink-0" />
              {ui.sendEmailReportLabel}
            </Label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                id="recipient-email"
                type="email"
                dir="ltr"
                placeholder="name@example.com"
                value={recipientEmail}
                onChange={(e) => onRecipientEmailChange(e.target.value)}
                className="bg-card font-mono text-sm"
              />
              <Button
                type="button"
                variant="secondary"
                onClick={onSaveRecipient}
                disabled={settingsSaveState === "saving"}
                className="shrink-0"
              >
                {settingsSaveState === "saving" ? (
                  <Spinner className="size-4" />
                ) : (
                  <Save className="size-4 me-1" />
                )}
                {ui.save}
              </Button>
            </div>
            {settingsSaveState === "saved" && (
              <p className="text-xs text-emerald-600">{ui.saved}</p>
            )}
            {settingsSaveState === "error" && (
              <p className="text-xs text-destructive">{ui.saveFailed}</p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Clock className="size-5 text-muted-foreground shrink-0" />
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              {ui.autoScanEvery}
            </span>
            <Select value={scanInterval} onValueChange={onIntervalChange}>
              <SelectTrigger className="flex-1 bg-card">
                <SelectValue placeholder={ui.selectFrequency} />
              </SelectTrigger>
              <SelectContent>
                {intervals.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            onClick={onExport}
            className="w-full h-12 border-primary/40 text-primary hover:bg-primary hover:text-primary-foreground"
          >
            <Download className="size-5 me-2 shrink-0" />
            {exportButtonLabel}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
