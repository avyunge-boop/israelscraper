/**
 * Bus Route Alerts Scraper — busnearby.co.il
 *
 * Persistent DB: data/routes-database.json (all routes ever seen, alertUrl per line).
 * Default: fast scan — one Chrome, up to ROUTE_SCAN_CONCURRENCY tabs. Only routes with missing
 *   or stale last_scanned_at (> SCAN_STALE_AFTER_H hours) are queued; fresh routes are skipped.
 * --refresh: rescan agencyFilter 0–50 (+ registry extras), merge new routes into DB.
 * --full-scan: ignore staleness and scan every route in the database.
 * After each queued route, routes-database.json is saved (serialized) so interrupts keep progress.
 * Failed navigation (3 tries): last_scan_failed=true, keep last_known_alerts; never remove route.
 *
 * Output: data/bus-alerts.json (+ data/bus-alerts-prev.json rotation, registry, diff log).
 * Email: load repo-root .env (see .gitignore). HTML summary via email-notifier.ts (nodemailer only).
 * Israel Railways (agencyFilter=2) is blacklisted — never scanned; stripped from DB on load.
 *
 * Run refresh: pnpm --filter @workspace/scraper exec tsx ./src/scrape-bus-alerts.ts --refresh
 *
 * Multi-source: implements AgencyScraper via runScan() → SourceScanResult.
 */

import { createHash } from "node:crypto";
import pLimit from "p-limit";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { execSync } from "child_process";
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

loadRootEnv();
const OUTPUT_FILE = BUS_ALERTS_JSON;
const PREV_OUTPUT_FILE = BUS_ALERTS_PREV_JSON;
const REGISTRY_FILE = AGENCIES_REGISTRY_JSON;
const ROUTES_DB_FILE = ROUTES_DATABASE_JSON;
const BASE_URL = "https://www.busnearby.co.il";

const AGENCY_FILTER_MIN = 0;
const AGENCY_FILTER_MAX = 50;

/** Page navigation to alertUrl */
const NAV_MAX_ATTEMPTS = 3;
const NAV_RETRY_DELAY_MS = 2000;

/** Concurrent Puppeteer tabs for route scans (single shared browser) */
const ROUTE_SCAN_CONCURRENCY = 10;

/** Rescan a route if last_scanned_at is missing or older than this many hours */
const SCAN_STALE_AFTER_H = 12;
const SCAN_STALE_AFTER_MS = SCAN_STALE_AFTER_H * 60 * 60 * 1000;

/** Live terminal progress: log every N completed routes in the scan queue */
const PROGRESS_LOG_EVERY = 50;

const PUPPETEER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const REFRESH_ARG = "--refresh";
const FULL_SCAN_ARG = "--full-scan";

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
}

interface BusAlertsSnapshot {
  contentIds?: string[];
  alerts?: DedupedAlert[];
}

// ── Registry & routes DB ────────────────────────────────────────────────────

function buildAgencyScanList(registryById: Map<string, RegistryAgencyEntry>): Agency[] {
  const ids = new Set<string>();
  for (let n = AGENCY_FILTER_MIN; n <= AGENCY_FILTER_MAX; n++) ids.add(String(n));
  for (const id of registryById.keys()) ids.add(id);
  const sorted = [...ids]
    .filter((id) => !BLACKLISTED_AGENCY_FILTER_IDS.has(id))
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
      ? (legacyAlerts as CachedAlert[])
      : [],
  };
}

async function saveRoutesDatabase(routesByPattern: Map<string, RouteRecord>) {
  const routes = [...routesByPattern.values()].sort((a, b) =>
    a.patternId.localeCompare(b.patternId)
  );
  const payload: RoutesDatabaseFile = { schemaVersion: 1, routes };
  await fs.writeFile(ROUTES_DB_FILE, JSON.stringify(payload, null, 2), "utf-8");
}

// ── Chrome ──────────────────────────────────────────────────────────────────

const MACOS_GOOGLE_CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function findChromiumExecutable(): string | undefined {
  for (const cmd of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try {
      return execSync(`which ${cmd} 2>/dev/null`, { encoding: "utf-8" }).trim() || undefined;
    } catch {
      /* continue */
    }
  }
  return undefined;
}

function resolveChromeExecutable(): string | undefined {
  const fromEnv =
    process.env.PUPPETEER_EXECUTABLE_PATH?.trim() ||
    process.env.CHROME_PATH?.trim();
  if (fromEnv) return fromEnv;
  if (process.platform === "darwin" && existsSync(MACOS_GOOGLE_CHROME)) {
    return MACOS_GOOGLE_CHROME;
  }
  return findChromiumExecutable();
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
  for (let attempt = 1; attempt <= NAV_MAX_ATTEMPTS; attempt++) {
    try {
      await page.goto(rec.alertUrl, {
        waitUntil: "domcontentloaded",
        timeout: 22000,
      });
      await sleep(400);
      const patches = await fetchAlertsInPage(page, rec.apiRouteId);
      rec.last_known_alerts = patchesToCached(patches);
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

/** Serialize DB writes so concurrent workers never corrupt JSON */
function createDbPersistQueue() {
  let chain: Promise<void> = Promise.resolve();
  return {
    scheduleSave(routesByPattern: Map<string, RouteRecord>) {
      chain = chain.then(() => saveRoutesDatabase(routesByPattern));
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
    },
  }));
}

function cliArgv(context?: ScraperRunContext): string[] {
  const forwarded = context?.forwardArgv;
  if (forwarded?.length) return forwarded;
  return process.argv.slice(2);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function runBusnearbyInternal(
  context?: ScraperRunContext
): Promise<SourceScanResult> {
  const argv = cliArgv(context);
  const refreshFromCli = argv.includes(REFRESH_ARG);
  const fullScanMode = argv.includes(FULL_SCAN_ARG);
  await ensureRepoDataDir();
  await migrateLegacyFileIfNeeded(LEGACY_ROUTES_DB, ROUTES_DB_FILE, fs);
  await migrateLegacyFileIfNeeded(LEGACY_BUS_ALERTS, OUTPUT_FILE, fs);
  await migrateLegacyFileIfNeeded(LEGACY_BUS_PREV, PREV_OUTPUT_FILE, fs);
  await migrateLegacyFileIfNeeded(LEGACY_REGISTRY, REGISTRY_FILE, fs);
  const registryById = await loadAgenciesRegistry();
  const routesByPattern = await loadRoutesDatabase();

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

  let discoveryMode = refreshFromCli;
  if (routesByPattern.size === 0) {
    if (!refreshFromCli) {
      console.log(
        "[busnearby] data/routes-database.json is missing or has no valid routes — enabling discovery (same as --refresh)."
      );
    }
    discoveryMode = true;
  }

  const chromePath = resolveChromeExecutable();
  console.log(
    chromePath ? `Using Chrome/Chromium: ${chromePath}` : "Using bundled Chromium"
  );
  console.log(
    discoveryMode ? "Mode: REFRESH (discover + scan)" : "Mode: FAST (database routes only)"
  );

  const launchArgs = chromePath
    ? ["--no-sandbox", "--disable-dev-shm-usage"]
    : [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
      ];

  const browser: Browser = await puppeteer.launch({
    headless: true,
    ...(chromePath ? { executablePath: chromePath } : {}),
    args: launchArgs,
  });

  const page = await browser.newPage();
  await applyPageDefaults(page);

  let filtersWithRoutes = 0;
  const nowIso = () => new Date().toISOString();

  if (discoveryMode) {
    const agencies = buildAgencyScanList(registryById);
    console.log(
      `\n═══ Refresh: discovering routes (${agencies.length} searchRoute pages) ═══\n`
    );

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
      } else {
        const entry = registryById.get(agency.id);
        if (entry) {
          entry.lastAttemptAt = attemptAt;
          entry.lastError = "timeout";
        }
        console.log(`0 (timeout — registry entry kept if present)`);
      }
    }

    await saveAgenciesRegistry(registryById);
    await saveRoutesDatabase(routesByPattern);
    console.log(`\nRegistry saved: ${REGISTRY_FILE}`);
    console.log(`Routes DB saved: ${ROUTES_DB_FILE} (${routesByPattern.size} route(s))`);
  }

  const routeList = [...routesByPattern.values()].sort((a, b) =>
    a.patternId.localeCompare(b.patternId)
  );

  const nowMs = Date.now();
  const scanQueue = fullScanMode
    ? routeList
    : routeList.filter((r) => routeNeedsRescan(r, nowMs));
  const skippedFresh = routeList.length - scanQueue.length;

  console.log(
    `\n═══ Route scan queue: ${scanQueue.length} stale/missing (of ${routeList.length} in DB) ═══`
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

  function logQueueProgress() {
    if (queueTotal === 0) return;
    const pct = ((queueCompleted / queueTotal) * 100).toFixed(1);
    const isMilestone =
      queueCompleted % PROGRESS_LOG_EVERY === 0 || queueCompleted === queueTotal;
    if (isMilestone) {
      console.log(`[${queueCompleted}/${queueTotal}] ${pct}% done....`);
      logScraperProgressLine({
        agency: "busnearby",
        displayName: BUSNEARBY_DISPLAY,
        current: queueCompleted,
        total: queueTotal,
        alertsFound: 0,
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
    ? buildAgencyScanList(registryById)
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
    routesSkippedFresh: skippedFresh,
    scanStaleAfterHours: SCAN_STALE_AFTER_H,
    fullScan: fullScanMode,
    rawAlertRowCount: rawAlerts.length,
    dedupedAlertCount: deduped.length,
    contentIds,
    alerts: deduped,
  };

  let previousSnapshot: BusAlertsSnapshot | null = null;
  if (existsSync(OUTPUT_FILE)) {
    try {
      previousSnapshot = JSON.parse(
        await fs.readFile(OUTPUT_FILE, "utf-8")
      ) as BusAlertsSnapshot;
    } catch {
      previousSnapshot = null;
    }
    await fs.rename(OUTPUT_FILE, PREV_OUTPUT_FILE);
    console.log(`\nPrevious snapshot renamed to: ${PREV_OUTPUT_FILE}`);
  }

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf-8");

  const prevIds = Array.isArray(previousSnapshot?.contentIds)
    ? previousSnapshot!.contentIds!
    : [];
  const prevByContentId = new Map<string, DedupedAlert>();
  for (const a of previousSnapshot?.alerts ?? []) {
    if (a?.contentId) prevByContentId.set(a.contentId, a);
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
  console.log(`Saved to               : ${OUTPUT_FILE}`);

  console.log(`\n═══ Resume from where you stopped ═══`);
  console.log(
    `  routes-database.json stores last_scanned_at; the next run only queues stale/missing routes (<${SCAN_STALE_AFTER_H}h), unless you use --full-scan.`
  );
  console.log(`  npm run --prefix scripts scrape-bus-alerts`);
  console.log(
    `  pnpm --filter @workspace/scraper run scrape-bus-alerts   (from repo root)`
  );
  console.log(
    `  npm run --prefix scripts scrape-bus-alerts:refresh   (re-discover agencies + same queue rules)`
  );
  console.log(
    `  npm run --prefix scripts scrape-bus-alerts:full   (scan every route in DB, ignore freshness)`
  );

  if (deduped.length > 0) {
    console.log("\nSample deduped alerts:");
    for (const s of deduped.slice(0, 3)) {
      console.log(`\n  contentId : ${s.contentId.slice(0, 16)}…`);
      console.log(
        `  Routes    : ${s.routeCount} (e.g. ${s.routes.slice(0, 3).map((r) => r.apiRouteId).join(", ")}${s.routeCount > 3 ? ", …" : ""})`
      );
      console.log(`  Title     : ${s.title}`);
      if (s.effectiveStart) console.log(`  From      : ${s.effectiveStart}`);
      if (s.effectiveEnd) console.log(`  To        : ${s.effectiveEnd}`);
      console.log(
        `  Status    : ${s.activeNow ? "Active now" : s.expired ? "Expired" : "Upcoming"}`
      );
      if (s.stopConditions.length) console.log(`  Type      : ${s.stopConditions.join(", ")}`);
      console.log(
        `  Content   : ${s.fullContent.slice(0, 200)}${s.fullContent.length > 200 ? "…" : ""}`
      );
    }
  }

  let normalizedAlerts = dedupedToNormalized(deduped);
  normalizedAlerts = await enrichBusnearbyAlertsWithGroq(normalizedAlerts);

  return {
    sourceId: "busnearby",
    displayName: BUSNEARBY_DISPLAY,
    success: true,
    scrapedAt,
    alerts: normalizedAlerts,
    meta: {
      outputFile: OUTPUT_FILE,
      uniqueRoutesInDatabase: routeList.length,
      routesScannedThisRun: scanQueue.length,
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
