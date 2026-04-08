/**
 * שורות לוג מובנות ל-SSE / מסוף — ניתן לפרסר בצד הלקוח.
 */
export type ScraperProgressPayload = {
  agency: string;
  displayName: string;
  current: number;
  total: number;
  alertsFound: number;
};

export function logScraperProgressLine(p: ScraperProgressPayload): void {
  console.log(`[SCRAPER_PROGRESS] ${JSON.stringify(p)}`);
}
