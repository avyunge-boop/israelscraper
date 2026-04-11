"use client"

import { Search, Bus, Clock, Globe, AlertTriangle } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { DashboardLang, DashboardUiStrings } from "@/lib/dashboard-i18n"

interface DashboardHeaderProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  lastUpdated: string
  lang: DashboardLang
  ui: DashboardUiStrings
  onLanguageChange: (lang: DashboardLang) => void
  healthOk?: boolean | null
  healthFailures?: string[]
  /** אזהרות (למשל חסר scan-export) כשהמערכת עדיין "בריאה" */
  healthWarnings?: string[]
}

export function DashboardHeader({
  searchQuery,
  onSearchChange,
  lastUpdated,
  lang,
  ui,
  onLanguageChange,
  healthOk,
  healthFailures = [],
  healthWarnings = [],
}: DashboardHeaderProps) {
  const showHealth = healthOk !== null && healthOk !== undefined
  const hasWarnings = healthOk && healthWarnings.length > 0
  const healthDot =
    !showHealth
      ? "bg-muted-foreground"
      : healthOk
        ? hasWarnings
          ? "bg-amber-500"
          : "bg-emerald-500"
        : "bg-destructive"

  return (
    <header className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-border">
      <div className="container mx-auto px-4 md:px-8 py-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex items-center justify-center size-12 rounded-xl bg-primary text-primary-foreground shrink-0">
              <Bus className="size-6" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 gap-y-1">
                <h1 className="text-xl font-bold text-foreground lg:text-2xl">
                  {ui.title}
                </h1>
                {showHealth && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/60"
                        title={
                          healthOk
                            ? hasWarnings
                              ? ui.healthWarningsHint
                              : ui.healthGood
                            : ui.healthIssues
                        }
                      >
                        <span
                          className={`size-2 rounded-full shrink-0 ${healthDot}`}
                          aria-hidden
                        />
                        {healthOk
                          ? hasWarnings
                            ? ui.healthWarningsShort
                            : ui.healthGood
                          : ui.healthBad}
                        {((!healthOk && healthFailures.length > 0) ||
                          hasWarnings) && (
                          <AlertTriangle className="size-3.5 text-amber-600" />
                        )}
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="max-w-sm">
                      {healthFailures.length > 0
                        ? healthFailures.map((f, i) => (
                            <DropdownMenuItem key={i} className="text-destructive">
                              {f}
                            </DropdownMenuItem>
                          ))
                        : null}
                      {healthWarnings.map((w, i) => (
                        <DropdownMenuItem
                          key={`w-${i}`}
                          className="text-amber-800 dark:text-amber-200 whitespace-normal"
                        >
                          {w}
                        </DropdownMenuItem>
                      ))}
                      {healthFailures.length === 0 &&
                        healthWarnings.length === 0 && (
                          <DropdownMenuItem disabled>
                            {ui.healthGood}
                          </DropdownMenuItem>
                        )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs shrink-0"
                  onClick={() => onLanguageChange(lang === "he" ? "en" : "he")}
                  aria-label={lang === "he" ? "Switch to English" : "עבור לעברית"}
                >
                  {ui.langSwitch}
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground mt-1">
                <div className="flex items-center gap-1.5">
                  <Clock className="size-4 shrink-0" />
                  <span>
                    {ui.lastUpdated} {lastUpdated}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Globe className="size-4 shrink-0" />
                  <span>{ui.globalSync}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="relative w-full sm:w-72">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder={ui.searchPlaceholder}
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="ps-10 bg-card"
            />
          </div>
        </div>
      </div>
    </header>
  )
}
