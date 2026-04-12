/**
 * שורות לוג מובנות ל-SSE / מסוף — ניתן לפרסר בצד הלקוח.
 */
export type ScraperProgressPayload = {
  agency: string;
  displayName: string;
  current: number;
  total: number;
  alertsFound: number;
  /** Optional human line for dashboards / log tail (e.g. current route). */
  detail?: string;
  /** `running` = לפני runScan; אחרת סיום סוכן (הצלחה או שגיאה). */
  phase?: "running" | "done" | "error";
};

export function logScraperProgressLine(p: ScraperProgressPayload): void {
  console.log(`[SCRAPER_PROGRESS] ${JSON.stringify(p)}`);
}
