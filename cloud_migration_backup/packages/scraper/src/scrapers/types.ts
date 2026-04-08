/**
 * Shared contract for all agency / source scrapers (multi-source dashboard).
 */

export interface NormalizedAlert {
  title: string;
  content: string;
  effectiveStart?: string;
  effectiveEnd?: string;
  /** Human-readable source label (e.g. operator name) */
  operatorLabel?: string;
  /** Direct URL to the notice on the operator site, if any */
  detailUrl?: string;
  meta?: Record<string, unknown>;
}

export interface SourceScanResult {
  /** Stable id: busnearby | egged | dan | metropoline | kavim */
  sourceId: string;
  displayName: string;
  success: boolean;
  scrapedAt: string;
  alerts: NormalizedAlert[];
  error?: string;
  meta?: Record<string, unknown>;
}

export interface ScraperRunContext {
  /** Extra CLI tokens after orchestrator args (e.g. --refresh for busnearby) */
  forwardArgv?: string[];
  /**
   * When true (e.g. orchestrator run), busnearby skips sending email but still fills
   * meta.busnearbyEmailPayload for a unified report.
   */
  suppressEmail?: boolean;
}

/**
 * Every scraper module exports runScan with this shape (duck-typed; use satisfies AgencyScraper).
 */
export interface AgencyScraper {
  readonly sourceId: string;
  readonly displayName: string;
  runScan(context?: ScraperRunContext): Promise<SourceScanResult>;
}

export type KnownAgencyId =
  | "busnearby"
  | "egged"
  | "dan"
  | "metropoline"
  | "kavim";

export const ALL_AGENCY_IDS: KnownAgencyId[] = [
  "busnearby",
  "egged",
  "dan",
  "metropoline",
  "kavim",
];
