"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import {
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  Languages,
} from "lucide-react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { sanitizeAiSummaryOutput } from "@/lib/ai-summary-sanitize"
import type { TransportAlert } from "@/lib/transport-alert"
import type { DashboardUiStrings } from "@/lib/dashboard-i18n"

export type { TransportAlert as Alert }

interface AlertCardProps {
  alert: TransportAlert
  ui: DashboardUiStrings
}

const providerStyles: Record<string, { bg: string; text: string; border: string; logo: string }> = {
  "אגד": { 
    bg: "bg-emerald-50", 
    text: "text-emerald-700", 
    border: "border-emerald-200",
    logo: "bg-emerald-500"
  },
  "דן": { 
    bg: "bg-sky-50", 
    text: "text-sky-700", 
    border: "border-sky-200",
    logo: "bg-sky-500"
  },
  "קווים": { 
    bg: "bg-amber-50", 
    text: "text-amber-700", 
    border: "border-amber-200",
    logo: "bg-amber-500"
  },
  "מטרופולין": { 
    bg: "bg-rose-50", 
    text: "text-rose-700", 
    border: "border-rose-200",
    logo: "bg-rose-500"
  },
  "אחר": {
    bg: "bg-muted",
    text: "text-muted-foreground",
    border: "border-border",
    logo: "bg-zinc-400",
  },
}

const busNearbyBadgeClass =
  "bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-950 dark:text-violet-200"

const PROCESSING_SUMMARY_PLACEHOLDER = "מעבד סיכום..."

function summaryDisplayText(raw: string | undefined): string {
  const s = sanitizeAiSummaryOutput(raw ?? "").trim()
  return s
}

function canCopyAiSummary(raw: string | undefined): boolean {
  const t = summaryDisplayText(raw)
  if (!t) return false
  if (t === PROCESSING_SUMMARY_PLACEHOLDER) return false
  return true
}

export function AlertCard({ alert, ui }: AlertCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [summaryCopied, setSummaryCopied] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [translationEn, setTranslationEn] = useState<string | null>(null)
  const [translateError, setTranslateError] = useState<string | null>(null)
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (copyResetRef.current) clearTimeout(copyResetRef.current)
    }
  }, [])

  useEffect(() => {
    setTranslationEn(null)
    setTranslateError(null)
  }, [alert.id])

  /** תצוגה: `aiSummary` חייב להתאים למפתחות ב־`ai-summaries.json` → `{ "byId": { [alert.id]: "..." } }` */
  const summaryText = summaryDisplayText(alert.aiSummary)
  const summaryBody = summaryText || ui.noSummaryYet

  const handleCopySummary = useCallback(async () => {
    if (!canCopyAiSummary(alert.aiSummary)) return
    const text = summaryDisplayText(alert.aiSummary)
    try {
      await navigator.clipboard.writeText(text)
      setSummaryCopied(true)
      if (copyResetRef.current) clearTimeout(copyResetRef.current)
      copyResetRef.current = setTimeout(() => {
        setSummaryCopied(false)
        copyResetRef.current = null
      }, 2000)
    } catch {
      setSummaryCopied(false)
    }
  }, [alert.aiSummary])

  const handleTranslate = useCallback(async () => {
    if (!canCopyAiSummary(alert.aiSummary)) return
    const text = summaryDisplayText(alert.aiSummary)
    setTranslating(true)
    setTranslateError(null)
    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        translation?: string
        error?: string
      }
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      const t = typeof data.translation === "string" ? data.translation.trim() : ""
      if (!t) throw new Error(ui.translateFailed)
      setTranslationEn(t)
    } catch (e) {
      setTranslationEn(null)
      setTranslateError(e instanceof Error ? e.message : ui.translateFailed)
    } finally {
      setTranslating(false)
    }
  }, [alert.aiSummary, ui.translateFailed])

  const shouldTruncate = alert.fullContent.length > 150
  const displayContent = shouldTruncate && !isExpanded 
    ? alert.fullContent.slice(0, 150) + "..." 
    : alert.fullContent

  const providerStyle = providerStyles[alert.provider] || providerStyles["אגד"]

  return (
    <Card className="flex h-full min-h-[200px] w-full min-w-0 flex-col overflow-hidden transition-all duration-200 hover:shadow-md border-border/60">
      <CardHeader className="pb-3 min-w-0">
        <div className="flex items-start justify-between gap-4 min-w-0">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {/* Status Badge */}
            {alert.isNew && (
              <Badge className="bg-primary text-primary-foreground">{ui.newBadge}</Badge>
            )}
            {/* Provider Badge with Logo */}
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className={`size-3 shrink-0 rounded-full ${providerStyle.logo}`} />
              <Badge 
                variant="outline"
                className={`font-medium ${providerStyle.bg} ${providerStyle.text} ${providerStyle.border}`}
              >
                {alert.provider}
              </Badge>
              {alert.dataSource === "busnearby" && (
                <Badge variant="outline" className={`font-medium ${busNearbyBadgeClass}`}>
                  Bus Nearby
                </Badge>
              )}
            </div>
            {/* Line Number Tags */}
            <div className="flex w-full min-w-0 flex-wrap gap-2">
            {alert.lineNumbers.map((line, idx) => (
              <span
                key={`${line}-${idx}`}
                className="inline-flex min-h-8 min-w-0 max-w-full items-center justify-center rounded-full bg-primary px-2 py-1 text-primary-foreground text-sm font-semibold break-words text-center"
              >
                {line}
              </span>
            ))}
            </div>
          </div>
        </div>
        <h3 className="text-lg font-bold text-foreground leading-relaxed mt-2 text-balance break-words">
          {alert.title}
        </h3>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-1 flex-col pt-0">
        <div
          className="mb-3 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-sm leading-relaxed"
          role="note"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-primary/15 pb-2 mb-2">
            <span className="text-xs font-bold uppercase tracking-wide text-primary">
              {ui.aiSummaryHeading}
            </span>
            <div className="flex flex-wrap items-center gap-1.5 justify-end shrink-0">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs border-primary/30"
                disabled={!canCopyAiSummary(alert.aiSummary)}
                onClick={handleCopySummary}
                aria-label={ui.copySummary}
              >
                {summaryCopied ? (
                  <>
                    <Check className="size-3.5 text-emerald-600 shrink-0" />
                    {ui.copied}
                  </>
                ) : (
                  <>
                    <Copy className="size-3.5 shrink-0" />
                    {ui.copySummary}
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs border-primary/30"
                disabled={
                  !canCopyAiSummary(alert.aiSummary) || translating
                }
                onClick={handleTranslate}
                aria-label={ui.translate}
              >
                <Languages className="size-3.5 shrink-0" />
                {translating ? ui.translating : ui.translate}
              </Button>
            </div>
          </div>
          <p
            className={
              summaryText
                ? "text-foreground break-words"
                : "text-muted-foreground italic text-xs sm:text-sm break-words"
            }
            dir="rtl"
          >
            {summaryBody}
          </p>
          {alert.summaryEn?.trim() && !translationEn && (
            <p
              className="mt-2 text-sm text-muted-foreground italic border-t border-primary/10 pt-2 break-words"
              dir="ltr"
              lang="en"
            >
              <span className="not-italic text-[0.65rem] font-semibold uppercase tracking-wide text-primary/80 me-2">
                {ui.translationEnglish}
              </span>
              {alert.summaryEn.trim()}
            </p>
          )}
          {translationEn && (
            <p
              className="mt-2 text-sm text-muted-foreground italic border-t border-primary/10 pt-2 break-words"
              dir="ltr"
              lang="en"
            >
              <span className="not-italic text-[0.65rem] font-semibold uppercase tracking-wide text-primary/80 me-2">
                {ui.translationEnglish}
              </span>
              {translationEn}
            </p>
          )}
          {translateError && (
            <p className="mt-1 text-xs text-destructive" dir="auto">
              {translateError}
            </p>
          )}
        </div>
        <p className="text-muted-foreground leading-relaxed text-sm break-words">
          {displayContent}
        </p>
        {shouldTruncate && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="mt-2 text-primary text-sm font-medium flex items-center gap-1 hover:underline cursor-pointer"
          >
            {isExpanded ? (
              <>
                {ui.readLess}
                <ChevronUp className="size-4" />
              </>
            ) : (
              <>
                {ui.readMore}
                <ChevronDown className="size-4" />
              </>
            )}
          </button>
        )}
        
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 mt-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="font-medium">{ui.dateStart}</span>
            <span>{alert.dateRange.start}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-medium">{ui.dateEnd}</span>
            <span>{alert.dateRange.end}</span>
          </div>
        </div>
        
        <Button
          asChild
          variant="outline"
          className="mt-4 border-primary/40 text-primary hover:bg-primary hover:text-primary-foreground"
        >
          <a href={alert.link} target="_blank" rel="noopener noreferrer">
            {ui.linkToSource}
            <ExternalLink className="size-4 me-2" />
          </a>
        </Button>
      </CardContent>
    </Card>
  )
}
