/**
 * דן — עדכונים (Webflow / Finsweet CMS):
 * רשימה: https://www.dan.co.il/updates
 */

import puppeteer, { type Page } from "puppeteer";

import type {
  AgencyScraper,
  NormalizedAlert,
  ScraperRunContext,
  SourceScanResult,
} from "../types";
import {
  normalizedAlertsToEmailDeduped,
  sendBusAlertsSummaryEmail,
  type SendBusAlertsEmailOptions,
} from "../../email-notifier";
import { buildPuppeteerLaunchOptions } from "../puppeteer-helpers";

const LIST_URL =
  process.env.DAN_ALERTS_URL?.trim() || "https://www.dan.co.il/updates";

const SITE_ORIGIN = "https://www.dan.co.il";

const DISPLAY_NAME = "דן";
const PROVIDER_LABEL = "דן";

const DAN_EMAIL_SUBJECT = "[דן] עדכוני תנועה - סריקה אחרונה";

const DAN_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SETTLE_MS = 2200;
const PAGINATION_CLICK_MS = 2000;
const MAX_PAGES = 60;
const DETAIL_TIMEOUT_MS = 60_000;

const DAN_LIST_EXTRACT_SCRIPT = `(function () {
  function text(el) {
    if (!el || !el.textContent) return "";
    return el.textContent.replace(/\\s+/g, " ").trim();
  }
  var wrappers = document.querySelectorAll("div.home-updates_item-wrapper");
  var out = [];
  for (var i = 0; i < wrappers.length; i++) {
    var w = wrappers[i];
    var tit = w.querySelector("div.updates_title-style");
    var title = tit ? text(tit) : "";
    var descEl = w.querySelector('p[fs-cmsfilter-field="description"]');
    var shortDescription = descEl ? text(descEl) : "";
    var link = w.querySelector('a[fs-list-element="item-link"]');
    var href = link ? (link.getAttribute("href") || "").trim() : "";
    if (!href) continue;
    out.push({
      title: title,
      shortDescription: shortDescription,
      href: href
    });
  }
  return out;
})()`;

const DAN_DETAIL_EXTRACT_SCRIPT = `(function () {
  function text(el) {
    if (!el || !el.textContent) return "";
    return el.textContent.replace(/\\s+/g, " ").trim();
  }
  var dateEl = document.querySelector("div.update-date");
  var updateDate = dateEl ? text(dateEl) : "";
  var rich = document.querySelector("div.rich-text-block.w-richtext");
  var fullContent = rich ? text(rich) : "";
  var lines = [];
  var wrap = document.querySelector("div.lines-collection-wrapper");
  if (wrap) {
    var dyn = wrap.querySelectorAll(".w-dyn-item");
    var k;
    if (dyn.length > 0) {
      for (k = 0; k < dyn.length; k++) {
        var t = text(dyn[k]);
        if (t) lines.push(t);
      }
    } else {
      var as = wrap.querySelectorAll("a[href*='/lines/']");
      for (k = 0; k < as.length; k++) {
        var t2 = text(as[k]);
        if (t2) lines.push(t2);
      }
    }
  }
  return { updateDate: updateDate, fullContent: fullContent, lineTexts: lines };
})()`;

interface DanListRow {
  title: string;
  shortDescription: string;
  href: string;
}

interface DanDetailExtract {
  updateDate: string;
  fullContent: string;
  lineTexts: string[];
}

function absoluteDanUrl(href: string): string {
  const h = href.trim();
  if (h.startsWith("http")) return h;
  if (h.startsWith("//")) return `https:${h}`;
  return `${SITE_ORIGIN}${h.startsWith("/") ? "" : "/"}${h}`;
}

/** מזהה ייחודי: סלאג אחרי /update/ */
function danSlugFromHref(href: string): string {
  try {
    const u = new URL(absoluteDanUrl(href));
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("update");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1]!;
    return parts[parts.length - 1] || href.trim();
  } catch {
    return href.trim();
  }
}

function uniqueLineLabels(raw: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    const t = x.replace(/\s+/g, " ").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

async function applyPageDefaults(page: Page): Promise<void> {
  await page.setUserAgent(DAN_MAC_UA);
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
}

async function extractListRows(page: Page): Promise<DanListRow[]> {
  const raw = (await page.evaluate(DAN_LIST_EXTRACT_SCRIPT)) as DanListRow[];
  return raw;
}

async function paginationNextAvailable(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector("a.w-pagination-next");
    if (!el) return false;
    if (!(el instanceof HTMLElement)) return false;
    if (el.offsetParent === null) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (el.classList.contains("w--disabled")) return false;
    if (el.getAttribute("aria-disabled") === "true") return false;
    if (el.classList.contains("filled")) return false;
    const label = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (label.indexOf("הבא") === -1) return false;
    return true;
  });
}

async function clickPaginationNext(page: Page): Promise<void> {
  const before = await page.$$eval(
    "div.home-updates_item-wrapper",
    (els) => els.length
  );
  const nextSel = "a.w-pagination-next";
  await page.waitForSelector(nextSel, { timeout: 10_000 });
  await page.click(nextSel);
  try {
    await page.waitForFunction(
      (n: number) =>
        document.querySelectorAll("div.home-updates_item-wrapper").length !== n,
      { timeout: 12_000 },
      before
    );
  } catch {
    /* אותו מספר פריטים או אין שינוי — ממשיכים */
  }
  await new Promise((r) => setTimeout(r, PAGINATION_CLICK_MS));
}

async function extractDetail(page: Page, url: string): Promise<DanDetailExtract> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: DETAIL_TIMEOUT_MS });
  await new Promise((r) => setTimeout(r, 800));
  const raw = (await page.evaluate(DAN_DETAIL_EXTRACT_SCRIPT)) as DanDetailExtract;
  return raw;
}

function danEmailOptions(scrapedAt: string, alerts: NormalizedAlert[]): SendBusAlertsEmailOptions {
  return {
    scrapedAt,
    added: [],
    removed: [],
    allAlerts: normalizedAlertsToEmailDeduped(alerts, "dan"),
    lineByPatternId: {},
    agencyLabelById: {},
    routesInDb: 0,
    routesQueued: alerts.length,
    routesSkippedFresh: 0,
    okCount: alerts.length,
    failCount: 0,
    scanStaleAfterHours: 12,
  };
}

export async function runScan(context?: ScraperRunContext): Promise<SourceScanResult> {
  const scrapedAt = new Date().toISOString();
  const suppressEmail = context?.suppressEmail === true;

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;

  try {
    browser = await puppeteer.launch(
      buildPuppeteerLaunchOptions(["--disable-gpu"])
    );

    const listPage = await browser.newPage();
    await applyPageDefaults(listPage);
    await listPage.goto(LIST_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    const bySlug = new Map<string, DanListRow>();
    let pagesVisited = 1;

    for (let pageIdx = 0; pageIdx < MAX_PAGES; pageIdx++) {
      const batch = await extractListRows(listPage);
      for (const row of batch) {
        const slug = danSlugFromHref(row.href);
        if (!slug || bySlug.has(slug)) continue;
        bySlug.set(slug, row);
      }

      const canNext = await paginationNextAvailable(listPage);
      if (!canNext) break;

      try {
        await clickPaginationNext(listPage);
        pagesVisited++;
      } catch {
        break;
      }
    }

    const queue = [...bySlug.entries()].sort(([a], [b]) => a.localeCompare(b));
    const detailPage = await browser.newPage();
    await applyPageDefaults(detailPage);

    const alerts: NormalizedAlert[] = [];
    let ok = 0;
    let fail = 0;

    for (const [slug, row] of queue) {
      const detailUrl = absoluteDanUrl(row.href);
      try {
        const detail = await extractDetail(detailPage, detailUrl);
        const lineNumbers = uniqueLineLabels(detail.lineTexts);
        const fullContent =
          detail.fullContent.trim() ||
          row.shortDescription.trim() ||
          row.title.trim() ||
          "עדכון";
        const content =
          row.shortDescription.trim() && row.shortDescription.trim() !== fullContent
            ? `${row.shortDescription.trim()}\n\n${fullContent}`.trim()
            : fullContent;

        alerts.push({
          title: row.title.trim() || "עדכון",
          content,
          effectiveStart: detail.updateDate.trim() || undefined,
          operatorLabel: PROVIDER_LABEL,
          detailUrl,
          meta: {
            fullDescription: fullContent,
            lineNumbers,
            danUpdateSlug: slug,
            link: detailUrl,
          },
        });
        ok++;
      } catch {
        fail++;
        alerts.push({
          title: row.title.trim() || "עדכון",
          content: row.shortDescription.trim() || row.title,
          operatorLabel: PROVIDER_LABEL,
          detailUrl,
          meta: {
            lineNumbers: [] as string[],
            danUpdateSlug: slug,
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

    console.log(
      `Dan: collected ${queue.length} items (${bySlug.size} unique slugs), deep OK ${ok}, failed ${fail}`
    );

    if (!suppressEmail && alerts.length > 0) {
      const sent = await sendBusAlertsSummaryEmail(danEmailOptions(scrapedAt, alerts), {
        groupCatalogByProvider: false,
        subjectOverride: DAN_EMAIL_SUBJECT,
      });
      if (sent.sent && sent.to) {
        console.log(`\x1b[32m✅ Dan email sent to ${sent.to}\x1b[0m`);
      }
    }

    return {
      sourceId: "dan",
      displayName: DISPLAY_NAME,
      success: true,
      scrapedAt,
      alerts,
      meta: {
        listUrl: LIST_URL,
        pagesVisited,
        queued: queue.length,
        deepOk: ok,
        deepFail: fail,
      },
    };
  } catch (e) {
    console.error("DETAILED_ERROR:", e);
    const msg = e instanceof Error ? e.message : String(e);
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
    return {
      sourceId: "dan",
      displayName: DISPLAY_NAME,
      success: false,
      scrapedAt,
      alerts: [],
      error: msg,
      meta: { listUrl: LIST_URL },
    };
  }
}

export const danScraper: AgencyScraper = {
  sourceId: "dan",
  displayName: DISPLAY_NAME,
  runScan,
};
