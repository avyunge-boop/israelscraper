/**
 * Bus Route Alerts Scraper — busnearby.co.il
 *
 * Persistent DB: data/routes-database.json (all routes ever seen, alertUrl per line). Discovery
 *   **merges** new links; normal runs never wipe the file. Train-only routes (agency 2) are removed
 *   by blacklist policy only.
 * First run / empty DB: route discovery runs automatically (same as --refresh) so Cloud/local need
 *   no separate “init” step.
 * Default: fast scan — one Chrome, up to ROUTE_SCAN_CONCURRENCY tabs. Only routes with missing
 *   or stale last_scanned_at (> BUSNEARBY_SCAN_STALE_AFTER_H hours) are queued for **alert** fetch;
 *   that is not a “deep” link discovery — use --refresh only when you want to re-crawl searchRoute pages.
 * --refresh: discover links on searchRoute pages (skips agencyFilters listed in busnearby-agency-exclusions.json).
 *   agencyFilters with 0 links are excluded until --restore-busnearby-agency-filters.
 * --full-scan: ignore staleness and scan every route in the database.
 * After each queued route, routes-database.json is saved (serialized) so interrupts keep progress.
 * Failed navigation (3 tries): last_scan_failed=true, keep last_known_alerts; never remove route.
 *
 * Output: data/bus-alerts.json (+ data/bus-alerts-prev.json rotation, registry, diff log).
 * Email: load repo-root .env (see .gitignore). HTML summary via email-notifier.ts (nodemailer only).
 * Israel Railways (agencyFilter=2) is blacklisted — never scanned; stripped from DB on load.
 *
 * Run refresh: pnpm --filter @workspace/scraper exec tsx ./src/scrape-bus-alerts.ts --refresh
 * Cap routes per run (Cloud Run): --max-routes=100 (limits stale-queue visits only).
 *
 * Multi-source: implements AgencyScraper via runScan() → SourceScanResult.
 */

import { createHash } from "node:crypto";
import pLimit from "p-limit";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { existsSync } from "fs";
import fs from "fs/promises";

import {
  BUSNEARBY_EMAIL_PAYLOAD_META_KEY,
  type BusnearbyEmailPayload,
  sendBusAlertsSummaryEmail,
} from "../../email-notifier";
import type {
  AgencyScraper,
  NormalizedAlert,
  ScraperRunContext,
  SourceScanResult,
} from "../types";
import { enrichBusnearbyAlertsWithGroq } from "../../groq-busnearby-enrich";
import {
  AGENCIES_REGISTRY_JSON,
  BUSNEARBY_AGENCY_EXCLUSIONS_JSON,
  BUS_ALERTS_JSON,
  BUS_ALERTS_PREV_JSON,
  ensureRepoDataDir,
  LEGACY_BUS_ALERTS,
  LEGACY_BUS_PREV,
  LEGACY_REGISTRY,
  LEGACY_ROUTES_DB,
  loadRootEnv,
  migrateLegacyFileIfNeeded,
  ROUTES_DATABASE_JSON,
} from "../../repo-paths";
import { logScraperProgressLine } from "../../scrape-progress";
import {
  getPuppeteerLaunchArgs,
  resolveChromeExecutable,
} from "../puppeteer-helpers";
import { rebuildScanExportAndMasterBusAlerts } from "../../lib/alerts-collector.js";
import {
  agencyAlertsFileName,
  agencyAlertsPath,
  type AgencyAlertsFileV1,
  mergeAndSaveAgencyAlertsFile,
} from "../../lib/agency-alerts-store.js";
import {
  hydrateRoutesDatabaseFromGcsIfConfigured,
  uploadDataArtifactsToGcs,
  uploadDataJsonFileToGcs,
} from "../../gcs-sync.js";

loadRootEnv();

/** Hours before re-fetching alerts for a route (not link discovery). Override via BUSNEARBY_SCAN_STALE_AFTER_H. */
function readScanStaleAfterHours(): number {
  const raw = process.env.BUSNEARBY_SCAN_STALE_AFTER_H?.trim();
  if (!raw) return 24;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 24;
  return Math.min(Math.floor(n), 24 * 30);
}

const OUTPUT_FILE = BUS_ALERTS_JSON;
const PREV_OUTPUT_FILE = BUS_ALERTS_PREV_JSON;
const AGENCY_ALERTS_FILE = agencyAlertsFileName("busnearby");
const REGISTRY_FILE = AGENCIES_REGISTRY_JSON;
const ROUTES_DB_FILE = ROUTES_DATABASE_JSON;
/** Basename for GCS single-file uploads (must match repo data layout). */
const ROUTES_DB_BASENAME = "routes-database.json";
const BASE_URL = "https://www.busnearby.co.il";

const AGENCY_FILTER_MIN = 0;
const AGENCY_FILTER_MAX = 50;

/** Page navigation to alertUrl */
const NAV_MAX_ATTEMPTS = 3;
const NAV_RETRY_DELAY_MS = 2000;

/** Concurrent Puppeteer tabs for route scans (single shared browser) */
const ROUTE_SCAN_CONCURRENCY = 10;

const SCAN_STALE_AFTER_H = readScanStaleAfterHours();
const SCAN_STALE_AFTER_MS = SCAN_STALE_AFTER_H * 60 * 60 * 1000;

/** Live terminal progress: log every N completed routes in the scan queue */
const PROGRESS_LOG_EVERY = 50;

const PUPPETEER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const REFRESH_ARG = "--refresh";
const FULL_SCAN_ARG = "--full-scan";
const RESTORE_AGENCY_FILTERS_ARG = "--restore-busnearby-agency-filters";

/** Permanently excluded: Israel Railways — buses only */
const ISRAEL_RAILWAYS_AGENCY_ID = "2";
const BLACKLISTED_AGENCY_FILTER_IDS = new Set<string>([ISRAEL_RAILWAYS_AGENCY_ID]);

// ── Types ───────────────────────────────────────────────────────────────────

interface Agency {
  id: string;
  name: string;
  url: string;
}

interface RegistryAgencyEntry {
  id: string;
  label: string;
  firstSeenAt: string;
  lastSuccessAt?: string;
  lastAttemptAt?: string;
  lastError?: "timeout" | "error";
}

interface AgenciesRegistryFile {
  schemaVersion: number;
  agencies: RegistryAgencyEntry[];
}

interface TimePeriod {
  startTime?: number;
  endTime?: number;
}

interface AlertPatch {
  id: string;
  alert: {
    alertHeaderText?: string;
    alertDescriptionText?: string;
    effectiveStartDate?: number;
    effectiveEndDate?: number;
  };
  timePeriods?: TimePeriod[];
  stopConditions?: string[];
  activeNow?: boolean;
  expired?: boolean;
  stop?: string;
  route?: string;
}

interface CachedAlert {
  alertId: string;
  title: string;
  fullContent: string;
  effectiveStart?: string;
  effectiveEnd?: string;
  activeNow: boolean;
  expired: boolean;
  stopConditions: string[];
  affectedStop?: string;
  /** Groq dispatcher sentence (Hebrew), persisted in routes-database.json */
  dispatcherSummaryHe?: string;
  /** English summary, persisted */
  summaryEn?: string;
  /** contentFingerprint(title, fullContent) when Groq fields are valid for this body */
  groqFingerprint?: string;
}

interface RouteRecord {
  id: string;
  agencyId: string;
  agencyIds: string[];
  lineNumber: string;
  description: string;
  /** Direct link to the route/alerts page */
  alertUrl: string;
  patternId: string;
  apiRouteId: string;
  last_scan_failed: boolean;
  last_scanned_at?: string;
  last_known_alerts: CachedAlert[];
}

interface RoutesDatabaseFile {
  schemaVersion: number;
  routes: RouteRecord[];
}

interface RawScrapedAlert {
  agencyFilterIds: string[];
  agencyLabels: string[];
  routeUrl: string;
  routeId: string;
  apiRouteId: string;
  alertId: string;
  title: string;
  fullContent: string;
  effectiveStart?: string;
  effectiveEnd?: string;
  activeNow: boolean;
  expired: boolean;
  stopConditions: string[];
  affectedStop?: string;
  cachedDispatcherHe?: string;
  cachedSummaryEn?: string;
}

interface RouteRef {
  apiRouteId: string;
  patternUrl: string;
  patternId: string;
  agencyFilterIds: string[];
}

interface DedupedAlert {
  contentId: string;
  title: string;
  fullContent: string;
  effectiveStart?: string;
  effectiveEnd?: string;
  activeNow: boolean;
  expired: boolean;
  stopConditions: string[];
  affectedStop?: string;
  sourceAlertIds: string[];
  routes: RouteRef[];
  routeCount: number;
  cachedDispatcherHe?: string;
  cachedSummaryEn?: string;
}

interface BusAlertsSnapshot {
  contentIds?: string[];
  alerts?: DedupedAlert[];
}

async function readPreviousBusnearbyContentIds(): Promise<string[]> {
  const seen = new Set<string>();
  const pushAll = (ids: unknown) => {
    if (!Array.isArray(ids)) return;
    for (const x of ids) {
      const s = String(x ?? "").trim();
      if (s) seen.add(s);
    }
  };

  const agencyPath = agencyAlertsPath("busnearby");
  if (existsSync(agencyPath)) {
    try {
      const raw = JSON.parse(
        await fs.readFile(agencyPath, "utf-8")
      ) as AgencyAlertsFileV1 & { lastContentIds?: unknown };
      pushAll(raw.lastContentIds);
      if (seen.size === 0) {
        for (const a of raw.alerts ?? []) {
          const cid =
            typeof a.meta?.contentId === "string"
              ? String(a.meta.contentId).trim()
              : "";
          if (cid) seen.add(cid);
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (seen.size === 0 && existsSync(OUTPUT_FILE)) {
    try {
      const raw = JSON.parse(
        await fs.readFile(OUTPUT_FILE, "utf-8")
      ) as BusAlertsSnapshot & { format?: string };
      if (raw.format !== "unified-dashboard") {
        pushAll(raw.contentIds);
      }
    } catch {
      /* ignore */
    }
  }

  if (seen.size === 0 && existsSync(PREV_OUTPUT_FILE)) {
    try {
      const raw = JSON.parse(
        await fs.readFile(PREV_OUTPUT_FILE, "utf-8")
      ) as BusAlertsSnapshot;
      pushAll(raw.contentIds);
    } catch {
      /* ignore */
    }
  }

  return [...seen];
}

function normalizedAlertToDedupedStub(
  a: NormalizedAlert,
  contentId: string
): DedupedAlert {
  const meta = a.meta && typeof a.meta === "object" ? a.meta : {};
  const m = meta as Record<string, unknown>;
  const stopRaw = m.stopConditions;
  const stopConditions = Array.isArray(stopRaw)
    ? stopRaw.map((x) => String(x))
    : [];

  return {
    contentId,
    title: a.title,
    fullContent: a.content,
    effectiveStart: a.effectiveStart,
    effectiveEnd: a.effectiveEnd,
    activeNow: Boolean(m.activeNow),
    expired: Boolean(m.expired),
    stopConditions,
    affectedStop: undefined,
    sourceAlertIds: [],
    routes: [],
    routeCount: typeof m.routeCount === "number" ? m.routeCount : 0,
    cachedDispatcherHe:
      typeof m.dispatcherSummaryHe === "string"
        ? m.dispatcherSummaryHe
        : undefined,
    cachedSummaryEn:
      typeof m.summaryEn === "string" ? m.summaryEn : undefined,
  };
}

async function loadPreviousNormalizedByContentId(): Promise<
  Map<string, NormalizedAlert>
> {
  const m = new Map<string, NormalizedAlert>();

  const agencyPath = agencyAlertsPath("busnearby");
  if (existsSync(agencyPath)) {
    try {
      const raw = JSON.parse(
        await fs.readFile(agencyPath, "utf-8")
      ) as AgencyAlertsFileV1;
      for (const a of raw.alerts ?? []) {
        const cid =
          typeof a.meta?.contentId === "string"
            ? String(a.meta.contentId).trim()
            : "";
        if (cid) m.set(cid, a);
      }
    } catch {
      /* ignore */
    }
  }

  if (m.size === 0 && existsSync(OUTPUT_FILE)) {
    try {
      const raw = JSON.parse(
        await fs.readFile(OUTPUT_FILE, "utf-8")
      ) as BusAlertsSnapshot & { format?: string };
      if (raw.format !== "unified-dashboard") {
        for (const d of raw.alerts ?? []) {
          if (!d?.contentId) continue;
          m.set(d.contentId, {
            title: d.title,
            content: d.fullContent,
            effectiveStart: d.effectiveStart,
            effectiveEnd: d.effectiveEnd,
            operatorLabel: "Bus Nearby (מספר מפעילים)",
            detailUrl: d.routes?.[0]?.patternUrl,
            meta: {
              contentId: d.contentId,
              activeNow: d.activeNow,
              expired: d.expired,
              stopConditions: d.stopConditions,
              routeCount: d.routeCount,
              dispatcherSummaryHe: d.cachedDispatcherHe,
              summaryEn: d.cachedSummaryEn,
            },
          });
        }
      }
    } catch {
      /* ignore */
    }
  }

  return m;
}

// ── Registry & routes DB ────────────────────────────────────────────────────

async function loadAgencyFilterExclusions(): Promise<Set<string>> {
  if (!existsSync(BUSNEARBY_AGENCY_EXCLUSIONS_JSON)) return new Set();
  try {
    const raw = JSON.parse(
      await fs.readFile(BUSNEARBY_AGENCY_EXCLUSIONS_JSON, "utf-8")
    ) as { excludedAgencyFilterIds?: unknown };
    const arr = raw.excludedAgencyFilterIds;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.map((x) => String(x)));
  } catch {
    return new Set();
  }
}

async function saveAgencyFilterExclusions(ids: Set<string>): Promise<void> {
  await ensureRepoDataDir();
  const list = [...ids].sort(
    (a, b) => (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b)
  );
  await fs.writeFile(
    BUSNEARBY_AGENCY_EXCLUSIONS_JSON,
    JSON.stringify(
      { schemaVersion: 1, excludedAgencyFilterIds: list },
      null,
      2
    ),
    "utf-8"
  );
}

function buildAgencyScanList(
  registryById: Map<string, RegistryAgencyEntry>,
  excludedFilterIds: Set<string>
): Agency[] {
  const ids = new Set<string>();
  for (let n = AGENCY_FILTER_MIN; n <= AGENCY_FILTER_MAX; n++) ids.add(String(n));
  for (const id of registryById.keys()) ids.add(id);
  const sorted = [...ids]
    .filter((id) => !BLACKLISTED_AGENCY_FILTER_IDS.has(id))
    .filter((id) => !excludedFilterIds.has(id))
    .sort((a, b) => (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b));
  return sorted.map((id) => {
    const reg = registryById.get(id);
    return {
      id,
      name: reg?.label ?? `agencyFilter=${id}`,
      url: `${BASE_URL}/searchRoute?agencyFilter=${id}`,
    };
  });
}

async function loadAgenciesRegistry(): Promise<Map<string, RegistryAgencyEntry>> {
  const map = new Map<string, RegistryAgencyEntry>();
  if (!existsSync(REGISTRY_FILE)) return map;
  try {
    const raw = await fs.readFile(REGISTRY_FILE, "utf-8");
    const data = JSON.parse(raw) as AgenciesRegistryFile;
    if (!Array.isArray(data.agencies)) return map;
    for (const a of data.agencies) {
      if (a?.id != null) map.set(String(a.id), { ...a, id: String(a.id) });
    }
  } catch {
    /* empty */
  }
  return map;
}

/** Drop agency 2 from registry and routes DB; delete routes that were train-only */
function applyIsraelRailwaysBlacklist(
  registryById: Map<string, RegistryAgencyEntry>,
  routesByPattern: Map<string, RouteRecord>
): { routesRemoved: number; registryRemoved: boolean; routesAdjusted: number } {
  let routesRemoved = 0;
  let routesAdjusted = 0;
  const registryRemoved = registryById.delete(ISRAEL_RAILWAYS_AGENCY_ID);

  for (const [patternId, rec] of [...routesByPattern.entries()]) {
    const nextIds = rec.agencyIds.filter(
      (id) => !BLACKLISTED_AGENCY_FILTER_IDS.has(id)
    );
    if (nextIds.length === 0) {
      routesByPattern.delete(patternId);
      routesRemoved++;
      continue;
    }
    if (nextIds.length !== rec.agencyIds.length) {
      rec.agencyIds = nextIds;
      rec.agencyId = nextIds[0]!;
      routesAdjusted++;
    }
  }

  return { routesRemoved, registryRemoved, routesAdjusted };
}

function searchUrlReferencesBlacklistedAgency(url: string): boolean {
  return /[?&]agency[Ff]ilter=2(?:&|$)/.test(url);
}

function buildLineLookupForEmail(
  routesByPattern: Map<string, RouteRecord>
): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of routesByPattern.values()) {
    const line = r.lineNumber?.trim();
    const hint =
      line ||
      (r.description?.trim() ? r.description.trim().slice(0, 48) : "") ||
      r.apiRouteId;
    m.set(r.patternId, hint);
  }
  return m;
}

function buildAgencyLabelLookup(
  registryById: Map<string, RegistryAgencyEntry>
): Map<string, string> {
  const m = new Map<string, string>();
  for (const [id, e] of registryById) {
    m.set(id, e.label);
  }
  return m;
}

async function saveAgenciesRegistry(registryById: Map<string, RegistryAgencyEntry>) {
  const agencies = [...registryById.values()].sort(
    (a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id)
  );
  await fs.writeFile(
    REGISTRY_FILE,
    JSON.stringify({ schemaVersion: 1, agencies }, null, 2),
    "utf-8"
  );
}

function normalizeRouteUrl(url: string): string {
  const u = url.split("?")[0];
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  if (u.startsWith("/")) return `${BASE_URL}${u}`;
  return `${BASE_URL}/${u}`;
}

async function loadRoutesDatabase(): Promise<Map<string, RouteRecord>> {
  const map = new Map<string, RouteRecord>();
  if (!existsSync(ROUTES_DB_FILE)) return map;
  try {
    const raw = (await fs.readFile(ROUTES_DB_FILE, "utf-8")).trim();
    if (!raw) return map;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return map;
    }
    const data = parsed as RoutesDatabaseFile;
    if (!Array.isArray(data.routes)) return map;
    for (const r of data.routes) {
      if (!r?.patternId) continue;
      map.set(r.patternId, migrateRouteRecord(r as unknown as Record<string, unknown>));
    }
  } catch {
    /* empty */
  }
  return map;
}

function migrateRouteRecord(raw: Record<string, unknown>): RouteRecord {
  const legacyFailed = raw.last_scan_failed ?? raw.lastScanFailed;
  const legacyAlerts = raw.last_known_alerts ?? raw.lastKnownAlerts;
  const rawAgencyIds = raw.agencyIds;
  const agencyIdsFrom = Array.isArray(rawAgencyIds)
    ? rawAgencyIds.map(String)
    : raw.agencyId
      ? [String(raw.agencyId)]
      : [];
  const agencyIds = [...new Set(agencyIdsFrom)].sort(
    (a, b) => Number(a) - Number(b) || a.localeCompare(b)
  );
  const patternId = String(raw.patternId ?? "");
  return {
    id: String(raw.id ?? patternId),
    agencyId: agencyIds[0] ?? String(raw.agencyId ?? ""),
    agencyIds,
    lineNumber: String(raw.lineNumber ?? ""),
    description: String(raw.description ?? ""),
    alertUrl: String(raw.alertUrl ?? ""),
    patternId,
    apiRouteId: String(raw.apiRouteId ?? ""),
    last_scan_failed: Boolean(legacyFailed),
    last_scanned_at:
      raw.last_scanned_at != null
        ? String(raw.last_scanned_at)
        : raw.lastScannedAt != null
          ? String(raw.lastScannedAt)
          : undefined,
    last_known_alerts: Array.isArray(legacyAlerts)
      ? legacyAlerts.map((x) =>
          normalizeCachedAlert(x as Record<string, unknown>)
        )
      : [],
  };
}

function normalizeCachedAlert(raw: Record<string, unknown>): CachedAlert {
  const stopConds = raw.stopConditions ?? raw.stop_conditions;
  return {
    alertId: String(raw.alertId ?? raw.id ?? "").trim(),
    title: String(raw.title ?? "").trim(),
    fullContent: String(raw.fullContent ?? raw.full_content ?? "").trim(),
    effectiveStart:
      raw.effectiveStart != null
        ? String(raw.effectiveStart)
        : raw.effective_start != null
          ? String(raw.effective_start)
          : undefined,
    effectiveEnd:
      raw.effectiveEnd != null
        ? String(raw.effectiveEnd)
        : raw.effective_end != null
          ? String(raw.effective_end)
          : undefined,
    activeNow: Boolean(raw.activeNow ?? raw.active_now),
    expired: Boolean(raw.expired),
    stopConditions: Array.isArray(stopConds)
      ? [...stopConds].map(String).sort()
      : [],
    affectedStop:
      raw.affectedStop != null
        ? String(raw.affectedStop)
        : raw.affected_stop != null
          ? String(raw.affected_stop)
          : undefined,
    dispatcherSummaryHe:
      typeof raw.dispatcherSummaryHe === "string"
        ? raw.dispatcherSummaryHe
        : undefined,
    summaryEn:
      typeof raw.summaryEn === "string" ? raw.summaryEn : undefined,
    groqFingerprint:
      typeof raw.groqFingerprint === "string"
        ? raw.groqFingerprint
        : undefined,
  };
}

async function saveRoutesDatabase(routesByPattern: Map<string, RouteRecord>) {
  const routes = [...routesByPattern.values()].sort((a, b) =>
    a.patternId.localeCompare(b.patternId)
  );
  const payload: RoutesDatabaseFile = { schemaVersion: 1, routes };
  await fs.writeFile(ROUTES_DB_FILE, JSON.stringify(payload, null, 2), "utf-8");
}

function toApiRouteId(patternId: string): string {
  const parts = patternId.split(":");
  return parts.slice(0, 2).join(":");
}

const MAX_VALID_MS = 32503680000000;

function tsToIso(ts?: number, isSeconds = false): string | undefined {
  if (!ts || ts <= 0) return undefined;
  const ms = isSeconds ? ts * 1000 : ts;
  if (ms > MAX_VALID_MS) return undefined;
  return new Date(ms).toISOString();
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function contentFingerprint(title: string, fullContent: string): string {
  const payload = `${title.trim()}\n${fullContent.trim()}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** After a fresh API scan, re-attach Groq fields from the previous cache when alertId + body still match. */
function mergeCachedGroqIntoFreshAlerts(
  fresh: CachedAlert[],
  previous: CachedAlert[]
): CachedAlert[] {
  const prevById = new Map(previous.map((c) => [c.alertId, c]));
  return fresh.map((c) => {
    const prev = prevById.get(c.alertId);
    const he = prev?.dispatcherSummaryHe?.trim();
    const en = prev?.summaryEn?.trim();
    if (!prev || !he || !en) return c;
    const fpNow = contentFingerprint(c.title, c.fullContent);
    if (prev.groqFingerprint) {
      if (prev.groqFingerprint !== fpNow) return c;
    } else if (prev.title !== c.title || prev.fullContent !== c.fullContent) {
      return c;
    }
    return {
      ...c,
      dispatcherSummaryHe: prev.dispatcherSummaryHe,
      summaryEn: prev.summaryEn,
      groqFingerprint: fpNow,
    };
  });
}

/** Persist Groq summaries onto per-route cached rows (same fingerprint as dedupe contentId). */
function applyGroqEnrichmentToRouteRecords(
  routesByPattern: Map<string, RouteRecord>,
  enriched: NormalizedAlert[]
): void {
  const byContent = new Map<string, { he: string; en: string }>();
  for (const a of enriched) {
    const cid =
      typeof a.meta?.contentId === "string" ? a.meta.contentId.trim() : "";
    const he =
      typeof a.meta?.dispatcherSummaryHe === "string"
        ? a.meta.dispatcherSummaryHe.trim()
        : "";
    const en =
      typeof a.meta?.summaryEn === "string" ? a.meta.summaryEn.trim() : "";
    if (!cid || !he || !en) continue;
    byContent.set(cid, { he, en });
  }
  for (const rec of routesByPattern.values()) {
    for (const c of rec.last_known_alerts) {
      const fp = contentFingerprint(c.title, c.fullContent);
      const g = byContent.get(fp);
      if (!g) continue;
      c.dispatcherSummaryHe = g.he;
      c.summaryEn = g.en;
      c.groqFingerprint = fp;
    }
  }
}

function guessLineNumber(linkText: string): string {
  const m = linkText.match(/^\s*(\d+[א-ת]?|[\d.]+)/u);
  return m ? m[1]! : "";
}

function patchesToCached(patches: AlertPatch[]): CachedAlert[] {
  const out: CachedAlert[] = [];
  for (const patch of patches) {
    const alert = patch.alert;
    const tp = patch.timePeriods?.[0];
    out.push({
      alertId: patch.id.trim(),
      title: alert.alertHeaderText ?? "",
      fullContent: alert.alertDescriptionText ?? "",
      effectiveStart:
        tsToIso(tp?.startTime, true) ?? tsToIso(alert.effectiveStartDate, false),
      effectiveEnd:
        tsToIso(tp?.endTime, true) ?? tsToIso(alert.effectiveEndDate, false),
      activeNow: patch.activeNow ?? false,
      expired: patch.expired ?? false,
      stopConditions: [...(patch.stopConditions ?? [])].sort(),
      affectedStop: patch.stop ?? undefined,
    });
  }
  return out;
}

function recordAgencyLabels(ids: string[]): string[] {
  return ids.map((id) => `agencyFilter=${id}`);
}

function cachedRowsToRawAlerts(rec: RouteRecord): RawScrapedAlert[] {
  const agencyFilterIds = [...rec.agencyIds].sort(
    (a, b) => Number(a) - Number(b) || a.localeCompare(b)
  );
  const agencyLabels = recordAgencyLabels(agencyFilterIds);
  const routeUrl = rec.alertUrl;
  return rec.last_known_alerts.map((c) => ({
    agencyFilterIds,
    agencyLabels,
    routeUrl,
    routeId: rec.patternId,
    apiRouteId: rec.apiRouteId,
    alertId: c.alertId,
    title: c.title,
    fullContent: c.fullContent,
    effectiveStart: c.effectiveStart,
    effectiveEnd: c.effectiveEnd,
    activeNow: c.activeNow,
    expired: c.expired,
    stopConditions: c.stopConditions,
    affectedStop: c.affectedStop,
    cachedDispatcherHe: c.dispatcherSummaryHe?.trim() || undefined,
    cachedSummaryEn: c.summaryEn?.trim() || undefined,
  }));
}

function dedupeAlertsByContent(raw: RawScrapedAlert[]): DedupedAlert[] {
  const groups = new Map<string, RawScrapedAlert[]>();
  for (const row of raw) {
    const fp = contentFingerprint(row.title, row.fullContent);
    const g = groups.get(fp) ?? [];
    g.push(row);
    groups.set(fp, g);
  }

  const out: DedupedAlert[] = [];
  for (const [contentId, rows] of groups) {
    rows.sort(
      (a, b) =>
        a.apiRouteId.localeCompare(b.apiRouteId) ||
        a.alertId.localeCompare(b.alertId) ||
        a.routeUrl.localeCompare(b.routeUrl)
    );
    const first = rows[0]!;
    const sourceAlertIds = [...new Set(rows.map((r) => r.alertId))].sort();

    const routeMap = new Map<string, RouteRef>();
    for (const r of rows) {
      const prev = routeMap.get(r.apiRouteId);
      const idSet = new Set(prev?.agencyFilterIds ?? []);
      for (const id of r.agencyFilterIds) idSet.add(id);
      routeMap.set(r.apiRouteId, {
        apiRouteId: r.apiRouteId,
        patternUrl: r.routeUrl,
        patternId: r.routeId,
        agencyFilterIds: [...idSet].sort(
          (a, b) => Number(a) - Number(b) || a.localeCompare(b)
        ),
      });
    }

    const routes = [...routeMap.values()].sort(
      (a, b) =>
        a.apiRouteId.localeCompare(b.apiRouteId) ||
        a.patternUrl.localeCompare(b.patternUrl)
    );

    const cachedDispatcherHe = rows
      .map((r) => r.cachedDispatcherHe?.trim())
      .find((x) => x);
    const cachedSummaryEn = rows
      .map((r) => r.cachedSummaryEn?.trim())
      .find((x) => x);

    out.push({
      contentId,
      title: first.title,
      fullContent: first.fullContent,
      effectiveStart: first.effectiveStart,
      effectiveEnd: first.effectiveEnd,
      activeNow: first.activeNow,
      expired: first.expired,
      stopConditions: [...first.stopConditions].sort(),
      affectedStop: first.affectedStop,
      sourceAlertIds,
      routes,
      routeCount: routes.length,
      ...(cachedDispatcherHe ? { cachedDispatcherHe } : {}),
      ...(cachedSummaryEn ? { cachedSummaryEn } : {}),
    });
  }

  out.sort((a, b) => a.contentId.localeCompare(b.contentId));
  return out;
}

// ── Puppeteer: discovery ────────────────────────────────────────────────────

const COLLECT_ROUTE_DETAILS_SCRIPT = `
(function () {
  var links = document.querySelectorAll('a[href*="/route/"]');
  var seen = {};
  var list = [];
  for (var i = 0; i < links.length; i++) {
    var href = (links[i].getAttribute("href") || "").split("?")[0];
    if (href.indexOf("/route/") === -1) continue;
    var full = href.indexOf("http") === 0 ? href : "https://www.busnearby.co.il" + href;
    if (seen[full]) continue;
    seen[full] = true;
    var text = (links[i].textContent || "").replace(/\\s+/g, " ").trim();
    list.push({ url: full, linkText: text });
  }
  return list;
})()
`;

interface LinkRow {
  url: string;
  linkText: string;
}

async function collectRouteDetails(
  page: Page,
  agency: Agency
): Promise<{ ok: true; items: LinkRow[] } | { ok: false }> {
  try {
    await page.goto(agency.url, { waitUntil: "networkidle2", timeout: 25000 });
    await sleep(2500);
    const items = (await page.evaluate(COLLECT_ROUTE_DETAILS_SCRIPT)) as LinkRow[];
    return { ok: true, items };
  } catch {
    return { ok: false };
  }
}

function mergeDiscoveryRow(
  routesByPattern: Map<string, RouteRecord>,
  url: string,
  linkText: string,
  agencyId: string
) {
  if (BLACKLISTED_AGENCY_FILTER_IDS.has(agencyId)) return;
  if (searchUrlReferencesBlacklistedAgency(url)) return;
  const patternUrl = normalizeRouteUrl(url);
  const patternId = (patternUrl.match(/\/route\/([^/?#]+)/) ?? [])[1] ?? "";
  if (!patternId) return;
  const apiRouteId = toApiRouteId(patternId);
  const lineNumber = guessLineNumber(linkText);
  const existing = routesByPattern.get(patternId);
  const agencySet = new Set(existing?.agencyIds ?? []);
  agencySet.add(agencyId);
  const agencyIds = [...agencySet].sort(
    (a, b) => Number(a) - Number(b) || a.localeCompare(b)
  );

  const description =
    !existing || linkText.length > (existing.description?.length ?? 0)
      ? linkText
      : existing.description;

  const next: RouteRecord = {
    id: patternId,
    agencyId: agencyIds[0]!,
    agencyIds,
    lineNumber: existing?.lineNumber || lineNumber || "",
    description,
    alertUrl: patternUrl,
    patternId,
    apiRouteId,
    last_scan_failed: existing?.last_scan_failed ?? false,
    last_scanned_at: existing?.last_scanned_at,
    last_known_alerts: existing?.last_known_alerts ?? [],
  };
  routesByPattern.set(patternId, next);
}

// ── In-page API (same Chrome session) ───────────────────────────────────────

async function fetchAlertsInPage(page: Page, apiRouteId: string): Promise<AlertPatch[]> {
  const patches = await page.evaluate(async (apiId) => {
    const u =
      "https://api.busnearby.co.il/directions/patch/routeAlerts/" +
      encodeURIComponent(apiId) +
      "?locale=he";
    const r = await fetch(u, {
      headers: {
        Accept: "application/json",
        Referer: "https://www.busnearby.co.il/",
      },
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = (await r.json()) as { alertPatches?: AlertPatch[] };
    return j.alertPatches ?? [];
  }, apiRouteId);
  return patches;
}

async function scanRouteWithRetries(page: Page, rec: RouteRecord): Promise<boolean> {
  const previousAlerts = rec.last_known_alerts;
  for (let attempt = 1; attempt <= NAV_MAX_ATTEMPTS; attempt++) {
    try {
      await page.goto(rec.alertUrl, {
        waitUntil: "domcontentloaded",
        timeout: 22000,
      });
      await sleep(400);
      const patches = await fetchAlertsInPage(page, rec.apiRouteId);
      const fresh = patchesToCached(patches);
      rec.last_known_alerts = mergeCachedGroqIntoFreshAlerts(
        fresh,
        previousAlerts
      );
      rec.last_scan_failed = false;
      rec.last_scanned_at = new Date().toISOString();
      return true;
    } catch {
      if (attempt < NAV_MAX_ATTEMPTS) await sleep(NAV_RETRY_DELAY_MS);
    }
  }
  rec.last_scan_failed = true;
  rec.last_scanned_at = new Date().toISOString();
  return false;
}

async function applyPageDefaults(page: Page) {
  await page.setUserAgent(PUPPETEER_UA);
  await page.setViewport({ width: 1280, height: 900 });
}

function routeNeedsRescan(rec: RouteRecord, nowMs: number): boolean {
  const raw = rec.last_scanned_at?.trim();
  if (!raw) return true;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return true;
  return nowMs - t > SCAN_STALE_AFTER_MS;
}

async function tryUploadJsonToGcs(
  fileName: string,
  label: string
): Promise<void> {
  if (process.env.SCRAPER_STORAGE !== "gcs") return;
  try {
    const url = await uploadDataJsonFileToGcs(fileName);
    if (url) console.log(`[busnearby/gcs] ${label}: ${url}`);
  } catch (e) {
    console.error(`[busnearby/gcs] ${label} (${fileName}) failed:`, e);
  }
}

async function tryUploadAllArtifactsToGcs(label: string): Promise<void> {
  if (process.env.SCRAPER_STORAGE !== "gcs") return;
  try {
    const uploaded = await uploadDataArtifactsToGcs();
    if (uploaded.length) {
      console.log(`[busnearby/gcs] ${label}: ${uploaded.length} object(s)`);
    }
  } catch (e) {
    console.error(`[busnearby/gcs] ${label} failed:`, e);
  }
}

/** Serialize DB writes so concurrent workers never corrupt JSON */
const GCS_UPLOAD_EVERY_N_ROUTES = 50;

function createDbPersistQueue() {
  let chain: Promise<void> = Promise.resolve();
  let savesSinceLastGcsUpload = 0;
  return {
    scheduleSave(routesByPattern: Map<string, RouteRecord>) {
      chain = chain.then(async () => {
        await saveRoutesDatabase(routesByPattern);
        if (process.env.SCRAPER_STORAGE !== "gcs") return;
        savesSinceLastGcsUpload++;
        if (savesSinceLastGcsUpload < GCS_UPLOAD_EVERY_N_ROUTES) return;
        savesSinceLastGcsUpload = 0;
        try {
          const url = await uploadDataJsonFileToGcs(ROUTES_DB_BASENAME);
          if (url) {
            console.log(
              `[busnearby/gcs] incremental routes DB (every ${GCS_UPLOAD_EVERY_N_ROUTES} saves): ${url}`
            );
          }
        } catch (e) {
          console.error("[busnearby/gcs] incremental routes DB upload failed:", e);
        }
      });
      return chain;
    },
    flush() {
      return chain;
    },
  };
}

const BUSNEARBY_DISPLAY = "Bus Nearby";

function dedupedToNormalized(alerts: DedupedAlert[]): NormalizedAlert[] {
  return alerts.map((d) => ({
    title: d.title,
    content: d.fullContent,
    effectiveStart: d.effectiveStart,
    effectiveEnd: d.effectiveEnd,
    operatorLabel: "Bus Nearby (מספר מפעילים)",
    detailUrl: d.routes[0]?.patternUrl,
    meta: {
      contentId: d.contentId,
      routeCount: d.routeCount,
      activeNow: d.activeNow,
      expired: d.expired,
      ...(d.cachedDispatcherHe?.trim()
        ? { dispatcherSummaryHe: d.cachedDispatcherHe.trim() }
        : {}),
      ...(d.cachedSummaryEn?.trim()
        ? { summaryEn: d.cachedSummaryEn.trim() }
        : {}),
    },
  }));
}

function cliArgv(context?: ScraperRunContext): string[] {
  const forwarded = context?.forwardArgv;
  if (forwarded?.length) return forwarded;
  return process.argv.slice(2);
}

/** Parse `--max-routes=N` from argv (Cloud Run / API cap). Returns undefined if unset or invalid. */
function parseMaxRoutesFromArgv(argv: string[]): number | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.match(/^--max-routes=(\d+)$/i);
    if (eq) {
      const n = Number(eq[1]);
      if (Number.isFinite(n) && n >= 1) return Math.min(Math.floor(n), 1_000_000);
      return undefined;
    }
    if (/^--max-routes$/i.test(a) && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      i++;
      if (Number.isFinite(n) && n >= 1) return Math.min(Math.floor(n), 1_000_000);
    }
  }
  return undefined;
}

type AutoContinueRunBody = {
  agency: "busnearby";
  refresh?: boolean;
  maxRoutes?: number;
  fullScan?: boolean;
};

async function tryAutoContinueBusnearbyBatch(
  body: AutoContinueRunBody,
  remainingRoutes: number
): Promise<void> {
  const base = process.env.SCRAPER_API_URL?.trim();
  if (!base) {
    console.log(
      "[busnearby] auto-continue skipped: SCRAPER_API_URL is not set"
    );
    return;
  }
  await sleep(5000);
  console.log(
    `[busnearby] auto-continuing: ${remainingRoutes} routes remaining, triggering next batch...`
  );
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/run-scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    if (!res.ok) {
      console.error(
        `[busnearby] auto-continue failed: HTTP ${res.status} ${txt.slice(0, 300)}`
      );
      return;
    }
    console.log(`[busnearby] auto-continue accepted: ${txt.slice(0, 300)}`);
  } catch (e) {
    console.error("[busnearby] auto-continue request failed:", e);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function runBusnearbyInternal(
  context?: ScraperRunContext
): Promise<SourceScanResult> {
  const argv = cliArgv(context);
  const refreshFromCli = argv.includes(REFRESH_ARG);
  /** --full-scan או JSON ‎fullScan:true‎ מ־POST /run-scrape (ממופה ב־server.ts) */
  const fullScanMode = argv.includes(FULL_SCAN_ARG);
  const restoreAgencyFilters = argv.includes(RESTORE_AGENCY_FILTERS_ARG);
  await ensureRepoDataDir();
  await migrateLegacyFileIfNeeded(LEGACY_ROUTES_DB, ROUTES_DB_FILE, fs);
  await migrateLegacyFileIfNeeded(LEGACY_BUS_ALERTS, OUTPUT_FILE, fs);
  await migrateLegacyFileIfNeeded(LEGACY_BUS_PREV, PREV_OUTPUT_FILE, fs);
  await migrateLegacyFileIfNeeded(LEGACY_REGISTRY, REGISTRY_FILE, fs);
  await hydrateRoutesDatabaseFromGcsIfConfigured();
  const registryById = await loadAgenciesRegistry();
  const routesByPattern = await loadRoutesDatabase();

  if (restoreAgencyFilters) {
    await saveAgencyFilterExclusions(new Set());
    console.log(
      "[busnearby] Cleared agency-filter exclusions (empty search pages can be scanned again on the next --refresh)."
    );
    if (!refreshFromCli && !fullScanMode) {
      const scrapedAt = new Date().toISOString();
      return {
        sourceId: "busnearby",
        displayName: BUSNEARBY_DISPLAY,
        success: true,
        scrapedAt,
        alerts: [],
        meta: { restoredBusnearbyAgencyExclusions: true },
      };
    }
  }

  console.log(
    "Policy: agencyFilter=2 (Israel Railways) is permanently excluded — buses only."
  );
  const bl = applyIsraelRailwaysBlacklist(registryById, routesByPattern);
  if (bl.routesRemoved > 0 || bl.registryRemoved || bl.routesAdjusted > 0) {
    await saveAgenciesRegistry(registryById);
    await saveRoutesDatabase(routesByPattern);
    console.log(
      `  Blacklist applied: removed ${bl.routesRemoved} train-only route(s), adjusted ${bl.routesAdjusted} bus route(s) (stripped rail agency), registry entry 2 removed=${bl.registryRemoved}`
    );
  }

  const needsInitialDiscovery = routesByPattern.size === 0;
  const discoveryMode = refreshFromCli || needsInitialDiscovery;
  if (needsInitialDiscovery && !refreshFromCli) {
    console.log(
      "[busnearby] routes-database.json is empty — running route discovery now (same as --refresh). " +
        "Discovered links are saved and reused forever unless you run --refresh again."
    );
  }


  let excludedFilterIds = await loadAgencyFilterExclusions();

  const chromePath = resolveChromeExecutable();
  console.log(
    chromePath ? `Using Chrome/Chromium: ${chromePath}` : "Using bundled Chromium"
  );
  const modeLabel = !discoveryMode
    ? "Mode: FAST (database routes only — alert refresh by staleness)"
    : needsInitialDiscovery && !refreshFromCli
      ? "Mode: INITIAL DISCOVERY (empty routes DB — filling searchRoute links, then scan)"
      : "Mode: REFRESH (--refresh — merge new links from searchRoute, then scan)";
  console.log(modeLabel);

  const browser: Browser = await puppeteer.launch({
    headless: true,
    ...(chromePath ? { executablePath: chromePath } : {}),
    args: getPuppeteerLaunchArgs(chromePath),
  });

  const page = await browser.newPage();
  await applyPageDefaults(page);

  let filtersWithRoutes = 0;
  const nowIso = () => new Date().toISOString();

  if (discoveryMode) {
    const agencies = buildAgencyScanList(registryById, excludedFilterIds);
    console.log(
      `\n═══ Refresh: discovering routes (${agencies.length} searchRoute pages; ${excludedFilterIds.size} agencyFilter(s) skipped as “no links”) ═══\n`
    );

    const newlyExcluded = new Set<string>();

    for (const agency of agencies) {
      process.stdout.write(`  [${agency.id}] ${agency.name} ... `);
      const collected = await collectRouteDetails(page, agency);
      const attemptAt = nowIso();

      if (collected.ok) {
        for (const row of collected.items) {
          mergeDiscoveryRow(routesByPattern, row.url, row.linkText, agency.id);
        }
        if (collected.items.length > 0) filtersWithRoutes++;

        let entry = registryById.get(agency.id);
        if (collected.items.length > 0 && !entry) {
          entry = {
            id: agency.id,
            label: agency.name,
            firstSeenAt: attemptAt,
            lastSuccessAt: attemptAt,
            lastAttemptAt: attemptAt,
          };
          registryById.set(agency.id, entry);
        } else if (entry) {
          entry.lastAttemptAt = attemptAt;
          entry.lastSuccessAt = attemptAt;
          delete entry.lastError;
        }
        console.log(`${collected.items.length} link(s)`);
        if (collected.items.length === 0) {
          newlyExcluded.add(agency.id);
          console.log(
            `    → excluded agencyFilter=${agency.id} (no links); won’t search this page again until --restore-busnearby-agency-filters`
          );
        }
      } else {
        const entry = registryById.get(agency.id);
        if (entry) {
          entry.lastAttemptAt = attemptAt;
          entry.lastError = "timeout";
        }
        console.log(`0 (timeout — registry entry kept if present; not excluded)`);
      }
    }

    for (const id of newlyExcluded) excludedFilterIds.add(id);
    await saveAgencyFilterExclusions(excludedFilterIds);

    await saveAgenciesRegistry(registryById);
    await saveRoutesDatabase(routesByPattern);
    console.log(`\nRegistry saved: ${REGISTRY_FILE}`);
    console.log(`Routes DB saved: ${ROUTES_DB_FILE} (${routesByPattern.size} route(s))`);
    await tryUploadJsonToGcs(ROUTES_DB_BASENAME, "after discovery");
  }

  const routeList = [...routesByPattern.values()].sort((a, b) =>
    a.patternId.localeCompare(b.patternId)
  );

  const nowMs = Date.now();
  const hadAnyFreshRouteBeforeRun = routeList.some(
    (r) => !routeNeedsRescan(r, nowMs)
  );
  let scanQueue = fullScanMode
    ? routeList
    : routeList.filter((r) => routeNeedsRescan(r, nowMs));
  const skippedFresh = routeList.length - scanQueue.length;

  const maxRoutesCap = parseMaxRoutesFromArgv(argv);
  const queueBeforeCap = scanQueue.length;
  if (maxRoutesCap != null && scanQueue.length > maxRoutesCap) {
    scanQueue = scanQueue.slice(0, maxRoutesCap);
    console.log(
      `[busnearby] --max-routes=${maxRoutesCap}: capped queue ${queueBeforeCap} → ${scanQueue.length} (remaining stale routes wait for next run)`
    );
  }

  console.log(
    `\n═══ Route scan queue: ${scanQueue.length} to scan this run (${queueBeforeCap} stale/missing of ${routeList.length} in DB) ═══`
  );
  if (fullScanMode) {
    console.log(`  (--full-scan: ignoring ${SCAN_STALE_AFTER_H}h freshness)`);
  } else {
    console.log(
      `  Skipped ${skippedFresh} route(s) already scanned within ${SCAN_STALE_AFTER_H}h`
    );
  }
  console.log(
    `  Running up to ${ROUTE_SCAN_CONCURRENCY} concurrent tab(s); saving DB after each route`
  );
  if (scanQueue.length > 0) {
    console.log(
      `  Live progress every ${PROGRESS_LOG_EVERY} routes: [done/total] % done....\n`
    );
  } else {
    console.log("");
  }

  const dbPersist = createDbPersistQueue();
  const limit = pLimit(ROUTE_SCAN_CONCURRENCY);
  const queueTotal = scanQueue.length;
  let queueCompleted = 0;
  let lastCompletedRoute: RouteRecord | undefined;

  function agencyHumanForRoute(rec: RouteRecord | undefined): string {
    if (!rec) return "—";
    const ids =
      rec.agencyIds.length > 0
        ? rec.agencyIds
        : rec.agencyId
          ? [rec.agencyId]
          : [];
    if (ids.length === 0) return "—";
    return ids
      .map((id) => registryById.get(id)?.label ?? id)
      .join(", ");
  }

  function logQueueProgress() {
    if (queueTotal === 0) return;
    const pct = ((queueCompleted / queueTotal) * 100).toFixed(1);
    const isMilestone =
      queueCompleted % PROGRESS_LOG_EVERY === 0 || queueCompleted === queueTotal;
    if (isMilestone) {
      const rec = lastCompletedRoute;
      const lineNo =
        rec?.lineNumber?.trim() ||
        (rec?.patternId ? rec.patternId.split(":").pop() : "") ||
        "—";
      const agencyHuman = agencyHumanForRoute(rec);
      const dest = rec?.alertUrl ?? "—";
      const destShort =
        dest.length > 96 ? `${dest.slice(0, 96)}…` : dest;
      const detail = `Line [${lineNo}] (${agencyHuman}) to ${destShort}`;
      console.log(
        `[${queueCompleted}/${queueTotal}] (${pct}%) | Scanning: ${detail}`
      );
      logScraperProgressLine({
        agency: "busnearby",
        displayName: BUSNEARBY_DISPLAY,
        current: queueCompleted,
        total: queueTotal,
        alertsFound: 0,
        detail,
      });
    }
  }

  const outcomes =
    scanQueue.length === 0
      ? []
      : await Promise.all(
          scanQueue.map((rec) =>
            limit(async () => {
              const tab = await browser.newPage();
              try {
                await applyPageDefaults(tab);
                const ok = await scanRouteWithRetries(tab, rec);
                if (!ok) {
                  console.log(
                    `  FAIL after ${NAV_MAX_ATTEMPTS} tries: ${rec.patternId} (${rec.alertUrl}) — kept last_known_alerts (${rec.last_known_alerts.length})`
                  );
                }
                await dbPersist.scheduleSave(routesByPattern);
                queueCompleted++;
                lastCompletedRoute = rec;
                logQueueProgress();
                return ok;
              } finally {
                await tab.close().catch(() => {});
              }
            })
          )
        );

  await dbPersist.flush();
  await saveRoutesDatabase(routesByPattern);
  if (scanQueue.length > 0) {
    await tryUploadJsonToGcs(
      ROUTES_DB_BASENAME,
      "after route queue (remainder < incremental batch)"
    );
  }
  console.log(`\nRoutes DB updated: ${ROUTES_DB_FILE}`);

  const okCount = outcomes.filter(Boolean).length;
  const failCount = outcomes.length - okCount;
  console.log(
    `  Queue finished: ${scanQueue.length} route(s) attempted, ok=${okCount}, fail=${failCount}`
  );

  await browser.close();

  const rawAlerts: RawScrapedAlert[] = [];
  for (const rec of routeList) {
    rawAlerts.push(...cachedRowsToRawAlerts(rec));
  }

  const scrapedAt = new Date().toISOString();
  const deduped = dedupeAlertsByContent(rawAlerts);
  const contentIds = deduped.map((a) => a.contentId);

  logScraperProgressLine({
    agency: "busnearby",
    displayName: BUSNEARBY_DISPLAY,
    current: queueTotal,
    total: queueTotal,
    alertsFound: deduped.length,
  });

  const agencies = discoveryMode
    ? buildAgencyScanList(registryById, excludedFilterIds)
    : [];
  const output = {
    schemaVersion: 1,
    format: "busnearby-alerts-deduped",
    source: BASE_URL,
    scrapedAt,
    scanMode: discoveryMode ? "refresh" : "fast",
    routesDatabase: ROUTES_DB_FILE,
    agencyFilterRange: { min: AGENCY_FILTER_MIN, max: AGENCY_FILTER_MAX },
    agencyFiltersScanned: discoveryMode ? agencies.length : 0,
    agencyFiltersWithRoutes: discoveryMode ? filtersWithRoutes : 0,
    uniqueRoutesInDatabase: routeList.length,
    routesScannedThisRun: scanQueue.length,
    staleRoutesEligibleBeforeCap: queueBeforeCap,
    maxRoutesPerRun: maxRoutesCap ?? null,
    routesSkippedFresh: skippedFresh,
    scanStaleAfterHours: SCAN_STALE_AFTER_H,
    fullScan: fullScanMode,
    rawAlertRowCount: rawAlerts.length,
    dedupedAlertCount: deduped.length,
    contentIds,
    alerts: deduped,
  };

  const prevIds = await readPreviousBusnearbyContentIds();
  const prevNormById = await loadPreviousNormalizedByContentId();
  const prevByContentId = new Map<string, DedupedAlert>();
  for (const [cid, a] of prevNormById) {
    prevByContentId.set(cid, normalizedAlertToDedupedStub(a, cid));
  }
  const prevSet = new Set(prevIds);
  const newSet = new Set(contentIds);
  const addedIds = contentIds.filter((id) => !prevSet.has(id));
  const removedIds = prevIds.filter((id) => !newSet.has(id));
  const newByContentId = new Map(deduped.map((a) => [a.contentId, a]));

  console.log(`\n═══ Added Alerts (${addedIds.length}) ═══`);
  if (addedIds.length === 0) {
    console.log("  (none)");
  } else {
    for (const id of addedIds) {
      const a = newByContentId.get(id);
      console.log(`  ${id}`);
      if (a?.title) console.log(`    ${a.title}`);
    }
  }

  console.log(`\n═══ Removed Alerts (${removedIds.length}) ═══`);
  if (removedIds.length === 0) {
    console.log("  (none)");
  } else {
    for (const id of removedIds) {
      const a = prevByContentId.get(id);
      console.log(`  ${id}`);
      if (a?.title) console.log(`    ${a.title}`);
    }
  }

  const lineByPatternId = Object.fromEntries(buildLineLookupForEmail(routesByPattern));
  const agencyLabelById = Object.fromEntries(buildAgencyLabelLookup(registryById));

  const asBusNearbyEmail = <T extends { contentId: string; title: string; fullContent: string; routes: RouteRef[] }>(
    rows: T[]
  ) => rows.map((a) => ({ ...a, providerDisplay: "Bus Nearby" }));

  const emailPayload: BusnearbyEmailPayload = {
    scrapedAt,
    added: asBusNearbyEmail(addedIds.map((id) => newByContentId.get(id)!).filter(Boolean)),
    removed: asBusNearbyEmail(removedIds.map((id) => prevByContentId.get(id)!).filter(Boolean)),
    allAlerts: asBusNearbyEmail(deduped),
    lineByPatternId,
    agencyLabelById,
    routesInDb: routeList.length,
    routesQueued: scanQueue.length,
    routesSkippedFresh: skippedFresh,
    okCount,
    failCount,
    scanStaleAfterHours: SCAN_STALE_AFTER_H,
  };

  const suppressEmail = context?.suppressEmail === true;
  if (!suppressEmail) {
    const emailResult = await sendBusAlertsSummaryEmail(emailPayload);

    if (emailResult.sent && emailResult.to) {
      console.log(
        `\x1b[32m✅ Summary email sent to ${emailResult.to} (Train links permanently excluded)\x1b[0m`
      );
    }
  }

  console.log(`\n═══ Done ═══`);
  console.log(`Routes in DB           : ${routeList.length}`);
  console.log(`Scan queue / skipped   : ${scanQueue.length} / ${skippedFresh}`);
  console.log(`Queue ok / fail        : ${okCount} / ${failCount}`);
  console.log(`Raw alert rows         : ${rawAlerts.length}`);
  console.log(`Deduped alerts         : ${deduped.length}`);
  console.log(`Saved to               : ${AGENCY_ALERTS_FILE} (+ master via collector)`);

  console.log(
    `\n═══ Next run ═══ stale window ${SCAN_STALE_AFTER_H}h; use --full-scan or --refresh as needed (see package scripts).`
  );

  let normalizedAlerts = dedupedToNormalized(deduped);
  try {
    normalizedAlerts = await enrichBusnearbyAlertsWithGroq(normalizedAlerts);
  } catch (e) {
    console.error(
      "[busnearby/groq] enrichment failed; continuing with alerts as-is:",
      e
    );
  }
  try {
    applyGroqEnrichmentToRouteRecords(routesByPattern, normalizedAlerts);
    await saveRoutesDatabase(routesByPattern);
  } catch (e) {
    console.error("[busnearby] failed to persist Groq fields to routes DB:", e);
  }

  await mergeAndSaveAgencyAlertsFile(
    {
      sourceId: "busnearby",
      displayName: BUSNEARBY_DISPLAY,
      success: true,
      scrapedAt,
      alerts: normalizedAlerts,
    },
    { lastContentIds: contentIds }
  );
  try {
    await rebuildScanExportAndMasterBusAlerts();
  } catch (e) {
    console.error(
      "[busnearby] rebuildScanExportAndMasterBusAlerts failed (scan-export left unchanged if collector aborted):",
      e
    );
  }
  await tryUploadAllArtifactsToGcs(
    "after Groq + agency file merge + collector (bus-alerts + scan-export)"
  );

  const remainingRoutes = Math.max(queueBeforeCap - (maxRoutesCap ?? Infinity), 0);
  const isFirstBatch = !hadAnyFreshRouteBeforeRun;
  if (
    queueBeforeCap > (maxRoutesCap ?? Infinity) &&
    maxRoutesCap != null &&
    (deduped.length > 0 || isFirstBatch)
  ) {
    const nextBody: AutoContinueRunBody = {
      agency: "busnearby",
      ...(refreshFromCli ? { refresh: true } : {}),
      ...(maxRoutesCap != null ? { maxRoutes: maxRoutesCap } : {}),
      ...(fullScanMode ? { fullScan: true } : {}),
    };
    await tryAutoContinueBusnearbyBatch(nextBody, remainingRoutes);
  }

  return {
    sourceId: "busnearby",
    displayName: BUSNEARBY_DISPLAY,
    success: true,
    scrapedAt,
    alerts: normalizedAlerts,
    meta: {
      outputFile: AGENCY_ALERTS_FILE,
      uniqueRoutesInDatabase: routeList.length,
      routesScannedThisRun: scanQueue.length,
      maxRoutesPerRun: maxRoutesCap ?? null,
      staleRoutesEligibleBeforeCap: queueBeforeCap,
      routesSkippedFresh: skippedFresh,
      dedupedCount: deduped.length,
      addedVsPreviousRun: addedIds.length,
      removedVsPreviousRun: removedIds.length,
      [BUSNEARBY_EMAIL_PAYLOAD_META_KEY]: emailPayload,
    },
  };
}

export async function runScan(
  context?: ScraperRunContext
): Promise<SourceScanResult> {
  try {
    return await runBusnearbyInternal(context);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Scraper failed:", err);
    return {
      sourceId: "busnearby",
      displayName: BUSNEARBY_DISPLAY,
      success: false,
      scrapedAt: new Date().toISOString(),
      alerts: [],
      error: msg,
    };
  }
}

export const busnearbyScraper: AgencyScraper = {
  sourceId: "busnearby",
  displayName: BUSNEARBY_DISPLAY,
  runScan,
};
