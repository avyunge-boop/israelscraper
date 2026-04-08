/**
 * קווים (Kavim) — רשימה + סריקת עומק לכל התראה.
 * רשימה: https://www.kavim-t.com/passenger-information/traffic-updates
 */

import path from "path";
import { fileURLToPath } from "url";
import puppeteer, { type Page } from "puppeteer";

import type {
  AgencyScraper,
  NormalizedAlert,
  ScraperRunContext,
  SourceScanResult,
} from "../types";
import { sendKavimTrafficEmail } from "../../email-notifier";
import { resolveChromeExecutable } from "../puppeteer-helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LIST_URL =
  process.env.KAVIM_ALERTS_URL?.trim() ||
  "https://www.kavim-t.com/passenger-information/traffic-updates";

const SITE_ORIGIN = "https://www.kavim-t.com";

const DEBUG_SCREENSHOT = path.resolve(__dirname, "../../../kavim-list-debug.png");

const DISPLAY_NAME = "קווים";
const PROVIDER_LABEL = "קווים";

const KAVIM_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SETTLE_MS = 2500;

/**
 * רשימה מורחבת: BEM (news-link--sticky וכו׳) + קישורי עדכון תחת traffic-updates.
 */
const LIST_LINK_SELECTOR =
  'a.news-link, a[class*="news-link"], a[href*="/traffic-updates/"]';

const KAVIM_LIST_EXTRACT_SCRIPT = `(function () {
  function text(el) {
    if (!el || !el.textContent) return "";
    return el.textContent.replace(/\\s+/g, " ").trim();
  }
  function isArticlePath(pathname) {
    var p = (pathname || "").replace(/\\/+$/, "");
    return /\\/traffic-updates\\/[^/]+\\/[^/]+$/.test(p);
  }
  var listPath = "/passenger-information/traffic-updates";
  var links = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(LIST_LINK_SELECTOR)}));
  var out = [];
  var skippedNoHref = 0;
  var skippedNotArticle = 0;
  for (var i = 0; i < links.length; i++) {
    var a = links[i];
    var href = (a.getAttribute("href") || "").trim();
    if (!href) {
      skippedNoHref++;
      continue;
    }
    try {
      var path = new URL(href, window.location.origin).pathname.replace(/\\/+$/, "") || "";
      if (path === listPath || path === listPath + "/") continue;
      if (!isArticlePath(path)) {
        skippedNotArticle++;
        continue;
      }
    } catch (e1) {
      skippedNotArticle++;
      continue;
    }
    var nm = a.querySelector("div.news-link__name");
    var title = nm ? text(nm) : "";
    if (!title) title = text(a).slice(0, 500);
    if (!title) title = (a.getAttribute("aria-label") || "").trim();
    var tm = a.querySelector("time.news-link__date, time[class*='news-link__date'], time");
    var datetime = tm ? (tm.getAttribute("datetime") || "") : "";
    var displayDate = tm ? text(tm) : "";
    out.push({
      href: href,
      title: title,
      datetime: datetime,
      displayDate: displayDate
    });
  }
  return { rows: out, skippedNoHref: skippedNoHref, skippedNotArticle: skippedNotArticle };
})()`;

/** ספירה ותיאור לפני סינון — רק a.news-link (בסיס להשוואה) */
const KAVIM_DEBUG_PRIMARY_SCRIPT = `(function () {
  function t(el) {
    if (!el || !el.textContent) return "";
    return el.textContent.replace(/\\s+/g, " ").trim();
  }
  var nodes = Array.prototype.slice.call(document.querySelectorAll("a.news-link"));
  var list = [];
  for (var i = 0; i < nodes.length; i++) {
    var a = nodes[i];
    list.push({
      index: i,
      href: (a.getAttribute("href") || "").trim(),
      textPreview: t(a).slice(0, 160),
      className: a.className || ""
    });
  }
  return { count: nodes.length, entries: list };
})()`;

const KAVIM_HIGHLIGHT_LIST_LINKS_SCRIPT = `(function () {
  function isArticlePath(pathname) {
    var p = (pathname || "").replace(/\\/+$/, "");
    return /\\/traffic-updates\\/[^/]+\\/[^/]+$/.test(p);
  }
  var listPath = "/passenger-information/traffic-updates";
  var sel = ${JSON.stringify(LIST_LINK_SELECTOR)};
  var nodes = document.querySelectorAll(sel);
  var n = 0;
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var href = (el.getAttribute("href") || "").trim();
    if (!href) continue;
    try {
      var path = new URL(href, window.location.origin).pathname.replace(/\\/+$/, "") || "";
      if (path === listPath || path === listPath + "/") continue;
      if (!isArticlePath(path)) continue;
    } catch (e) {
      continue;
    }
    el.style.boxShadow = "0 0 0 3px #22c55e, 0 0 12px rgba(34,197,94,0.6)";
    el.style.outline = "2px solid #15803d";
    el.style.outlineOffset = "2px";
    n++;
  }
  return n;
})()`;

const KAVIM_DETAIL_EXTRACT_SCRIPT = `(function () {
  function text(el) {
    if (!el || !el.textContent) return "";
    return el.textContent.replace(/\\s+/g, " ").trim();
  }
  var rb = document.querySelector("div.redactor-block.updates");
  var fullContent = rb ? text(rb) : "";
  var lineEntries = [];
  var counts = document.querySelectorAll("a.news-count");
  for (var i = 0; i < counts.length; i++) {
    var link = counts[i];
    var label = (link.getAttribute("aria-label") || "").trim();
    var board = link.querySelector("div.news-count__board");
    var boardText = board ? text(board) : "";
    var tit = link.querySelector("div.news-count__title");
    var dest = tit ? text(tit) : "";
    var lineNum = boardText;
    if (!lineNum && label) {
      var m = label.match(/\\d{1,4}/);
      if (m) lineNum = m[0];
    }
    var row = [];
    if (lineNum) row.push(lineNum);
    if (dest) row.push(dest);
    var entry = row.join(" — ");
    if (entry) lineEntries.push(entry);
    else if (label) lineEntries.push(label);
  }
  return { fullContent: fullContent, lineEntries: lineEntries };
})()`;

interface KavimListRow {
  href: string;
  title: string;
  datetime: string;
  displayDate: string;
}

interface KavimListExtractResult {
  rows: KavimListRow[];
  skippedNoHref: number;
  skippedNotArticle: number;
}

interface KavimDetailExtract {
  fullContent: string;
  lineEntries: string[];
}

interface KavimDebugPrimary {
  count: number;
  entries: { index: number; href: string; textPreview: string; className: string }[];
}

function absoluteKavimUrl(href: string): string {
  const h = href.trim();
  if (h.startsWith("http")) return h;
  if (h.startsWith("//")) return `https:${h}`;
  return `${SITE_ORIGIN}${h.startsWith("/") ? "" : "/"}${h}`;
}

/** מפתח דדופ: pathname+search מלא — מונע איחוד בטעות של שני עדכונים עם אותו מספר בסוף נתיב שונה */
function kavimDedupKey(href: string): string {
  try {
    const u = new URL(absoluteKavimUrl(href));
    u.hash = "";
    return (u.pathname + u.search).replace(/\/+$/, "") || u.href;
  } catch {
    return href.trim();
  }
}

async function applyPageDefaults(page: Page): Promise<void> {
  await page.setUserAgent(KAVIM_MAC_UA);
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
}

async function extractList(page: Page): Promise<KavimListExtractResult> {
  const raw = await page.evaluate(KAVIM_LIST_EXTRACT_SCRIPT);
  return raw as KavimListExtractResult;
}

async function extractDetail(page: Page, url: string): Promise<KavimDetailExtract> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 800));
  const raw = await page.evaluate(KAVIM_DETAIL_EXTRACT_SCRIPT);
  return raw as KavimDetailExtract;
}

function effectiveDateFromList(datetime: string, displayDate: string): string | undefined {
  const d = datetime.trim();
  if (d) return d;
  const disp = displayDate.trim();
  return disp || undefined;
}

export async function runScan(context?: ScraperRunContext): Promise<SourceScanResult> {
  const scrapedAt = new Date().toISOString();
  const chromePath = resolveChromeExecutable();
  const suppressEmail = context?.suppressEmail === true;

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;

  try {
    browser = await puppeteer.launch({
      headless: true,
      ...(chromePath ? { executablePath: chromePath } : {}),
      args: chromePath
        ? ["--no-sandbox", "--disable-dev-shm-usage"]
        : ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });

    const listPage = await browser.newPage();
    await applyPageDefaults(listPage);
    await listPage.goto(LIST_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    const primaryDebug = (await listPage.evaluate(
      KAVIM_DEBUG_PRIMARY_SCRIPT
    )) as KavimDebugPrimary;

    console.log(
      `Kavim [debug] a.news-link elements (before filtering): ${primaryDebug.count}`
    );
    for (const e of primaryDebug.entries) {
      console.log(
        `  [${e.index}] class="${e.className}" href=${e.href || "(empty)"} text="${e.textPreview}"`
      );
    }

    const highlighted = await listPage.evaluate(KAVIM_HIGHLIGHT_LIST_LINKS_SCRIPT);
    await listPage.screenshot({ path: DEBUG_SCREENSHOT, fullPage: true });
    console.log(
      `Kavim [debug] Highlighted ${highlighted} link(s) with inclusive selector → ${DEBUG_SCREENSHOT}`
    );

    const { rows: rawList, skippedNoHref, skippedNotArticle } = await extractList(listPage);

    const inclusiveCount = await listPage.evaluate(
      `document.querySelectorAll(${JSON.stringify(LIST_LINK_SELECTOR)}).length`
    );
    const skippedTotal = skippedNoHref + skippedNotArticle;

    const seenIds = new Set<string>();
    const queue: KavimListRow[] = [];
    let skippedDedup = 0;
    for (const row of rawList) {
      const key = kavimDedupKey(row.href);
      if (seenIds.has(key)) {
        skippedDedup++;
        console.log(`Kavim [debug] dedup skip same path: ${key}`);
        continue;
      }
      seenIds.add(key);
      queue.push(row);
    }

    const detailPage = await browser.newPage();
    await applyPageDefaults(detailPage);

    const alerts: NormalizedAlert[] = [];
    let ok = 0;
    let fail = 0;

    for (let i = 0; i < queue.length; i++) {
      const row = queue[i]!;
      const detailUrl = absoluteKavimUrl(row.href);
      const updateId = kavimDedupKey(row.href);

      try {
        const detail = await extractDetail(detailPage, detailUrl);
        const content =
          detail.fullContent.trim() ||
          row.title.trim() ||
          "עדכון תנועה";
        const lineNumbers = detail.lineEntries;

        alerts.push({
          title: row.title.trim() || "עדכון",
          content,
          effectiveStart: effectiveDateFromList(row.datetime, row.displayDate),
          operatorLabel: PROVIDER_LABEL,
          detailUrl,
          meta: {
            fullDescription: content,
            lineNumbers,
            kavimUpdateId: updateId,
            link: detailUrl,
            dateDisplay: row.displayDate || null,
          },
        });
        ok++;
      } catch {
        fail++;
        alerts.push({
          title: row.title.trim() || "עדכון",
          content: [row.displayDate, row.datetime].filter(Boolean).join(" ") || row.title,
          effectiveStart: effectiveDateFromList(row.datetime, row.displayDate),
          operatorLabel: PROVIDER_LABEL,
          detailUrl,
          meta: {
            lineNumbers: [] as string[],
            kavimUpdateId: updateId,
            link: detailUrl,
            detailScrapeFailed: true,
          },
        });
      }
    }

    await detailPage.close();
    await listPage.close();
    await browser.close();
    browser = undefined;

    const skippedPreQueue = skippedTotal + skippedDedup;
    console.log(
      `Kavim: Found ${queue.length} links, processed ${ok} successfully, ${skippedPreQueue} skipped` +
        (fail > 0 ? `, ${fail} failed` : "") +
        ` (${primaryDebug.count} a.news-link, ${inclusiveCount} inclusive DOM, ${skippedNotArticle} not article URL, ${skippedDedup} deduped).`
    );

    if (!suppressEmail && alerts.length > 0) {
      const sent = await sendKavimTrafficEmail({ scrapedAt, alerts });
      if (sent.sent && sent.to) {
        console.log(`\x1b[32m✅ Kavim email sent to ${sent.to}\x1b[0m`);
      }
    }

    return {
      sourceId: "kavim",
      displayName: DISPLAY_NAME,
      success: true,
      scrapedAt,
      alerts,
      meta: {
        listUrl: LIST_URL,
        primaryNewsLinkCount: primaryDebug.count,
        inclusiveLinkCount: inclusiveCount,
        rawRowsAfterHref: rawList.length,
        skippedNoHref,
        skippedNotArticle,
        skippedDedup,
        queued: queue.length,
        deepOk: ok,
        deepFail: fail,
        debugScreenshot: DEBUG_SCREENSHOT,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
    return {
      sourceId: "kavim",
      displayName: DISPLAY_NAME,
      success: false,
      scrapedAt,
      alerts: [],
      error: msg,
      meta: { listUrl: LIST_URL },
    };
  }
}

export const kavimScraper: AgencyScraper = {
  sourceId: "kavim",
  displayName: DISPLAY_NAME,
  runScan,
};
