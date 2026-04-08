/**
 * אגד — דף עדכוני תנועה: https://www.egged.co.il/traffic-updates
 * גישה ישירה: כל כרטיס ב-DOM נכנס לתור; לכל אחד ניווט לדף פנימי וחילוץ מלא.
 * דף הרשימה נשאר פתוח ב־`page`; סריקת פרטים ב־`detailPage` (ללא חזרה לרשימה בפועל).
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
import { buildPuppeteerLaunchOptions } from "../puppeteer-helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LIST_URL =
  process.env.EGGED_ALERTS_URL?.trim() || "https://www.egged.co.il/traffic-updates";

/** צילום מסך לפני ספירת כרטיסים (דיבוג) */
const DEBUG_SCREENSHOT_FILE = path.resolve(__dirname, "../../../egged-debug.png");

const EGGED_MAC_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MUI_SETTLE_MS = 3000;

const LOAD_MORE_SEL = 'button[class*="TrafficUpdates-StyledButton"]';
/**
 * מעטפת הכרטיס ברשימה — ספירה, Grinder וחילוץ. כולל TrafficBox למקרה של שינוי שם המחלקה באתר.
 */
const CARD_LINK_SEL =
  'a[class*="TraffixBox-StyledContainer"], a[class*="TrafficBox-StyledContainer"]';

const MAX_LOAD_MORE_CLICKS = 15;
const LOAD_MORE_GROWTH_WAIT_MS = 3000;
const LOAD_MORE_POLL_MS = 150;

const DISPLAY_NAME = "אגד";

export interface EggedScrapingResult extends SourceScanResult {
  meta?: SourceScanResult["meta"] &
    Partial<{
      listUrl: string;
      queueLength: number;
      successCount: number;
      failCount: number;
      loadMoreClicks: number;
    }>;
}

/** שורה מהרשימה — כל אלמנט DOM, ללא דה-דופ לפי contentId */
interface ListCardRow {
  listIndex: number;
  href: string;
  title: string;
  dateTexts: string[];
}

/** מזהה יציב כמו ב-egged-alerts.json / מפתח ai-summaries (egged-{id}) */
function eggedContentIdFromDetailUrl(url: string): string {
  const u = url.trim();
  const m = u.match(/\/traffic-updates\/(\d+)/i) ?? u.match(/(\d{8,})(?:\/?|[?#]|$)/);
  return (m?.[1] ?? "").trim();
}

function absoluteEggedUrl(href: string): string {
  const h = href.trim();
  if (h.startsWith("http")) return h;
  if (h.startsWith("//")) return `https:${h}`;
  return `https://www.egged.co.il${h.startsWith("/") ? "" : "/"}${h}`;
}

async function applyPageDefaults(page: Page): Promise<void> {
  await page.setUserAgent(EGGED_MAC_CHROME_UA);
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
}

async function waitMuiSettleMs(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function evalCardCount(page: Page, selector: string): Promise<number> {
  const n = await page.evaluate(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`
  );
  return Number(n);
}

async function evalLoadMoreVisible(page: Page, buttonSelector: string): Promise<boolean> {
  const v = await page.evaluate(`(function () {
    var btn = document.querySelector(${JSON.stringify(buttonSelector)});
    if (!btn) return false;
    var r = btn.getBoundingClientRect();
    var st = window.getComputedStyle(btn);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  })()`);
  return Boolean(v);
}

const SCROLL_TO_BOTTOM_SCRIPT = `(function () {
  var h = document.body.scrollHeight || document.documentElement.scrollHeight;
  window.scrollTo(0, h);
})()`;

async function evalScrollToBottom(page: Page): Promise<void> {
  await page.evaluate(SCROLL_TO_BOTTOM_SCRIPT);
}

async function evalNativeButtonClick(page: Page, buttonSelector: string): Promise<boolean> {
  const v = await page.evaluate(`(function () {
    var btn = document.querySelector(${JSON.stringify(buttonSelector)});
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  return Boolean(v);
}

async function waitForCardCountGrowth(
  page: Page,
  cardSelector: string,
  previousCount: number,
  maxWaitMs: number
): Promise<number> {
  const deadline = Date.now() + maxWaitMs;
  let last = previousCount;
  while (Date.now() < deadline) {
    last = await evalCardCount(page, cardSelector);
    if (last > previousCount) return last;
    await new Promise((r) => setTimeout(r, LOAD_MORE_POLL_MS));
  }
  return last;
}

async function grindLoadAll(page: Page): Promise<number> {
  let clicks = 0;
  while (clicks < MAX_LOAD_MORE_CLICKS) {
    const before = await evalCardCount(page, CARD_LINK_SEL);

    await evalScrollToBottom(page);

    const visible = await evalLoadMoreVisible(page, LOAD_MORE_SEL);

    console.log(
      `Egged [Grinder] iteration ${clicks}: cards=${before}, loadMoreVisible=${visible}`
    );

    if (!visible) {
      console.log("Egged [Grinder] stop: load-more button not visible");
      break;
    }

    const clicked = await evalNativeButtonClick(page, LOAD_MORE_SEL);
    if (!clicked) {
      console.log("Egged [Grinder] stop: native click — button not found in DOM");
      break;
    }

    const after = await waitForCardCountGrowth(
      page,
      CARD_LINK_SEL,
      before,
      LOAD_MORE_GROWTH_WAIT_MS
    );

    console.log(
      `Egged [Grinder] Clicking Load More... Cards before: ${before}, Cards after: ${after}`
    );

    if (after <= before) {
      console.log(
        "Egged [Grinder] stop: card count did not increase within " +
          LOAD_MORE_GROWTH_WAIT_MS +
          "ms"
      );
      break;
    }
    clicks++;
  }

  const finalCount = await evalCardCount(page, CARD_LINK_SEL);
  console.log(
    `Egged [Grinder] done: ${clicks} load-more click(s), final TraffixBox card count=${finalCount}`
  );

  return clicks;
}

/**
 * רשימה: רק בתוך מעטפת StyledContainer — TopBox (כותרת/תאריכים), אופציונלית Content בתוך אותו shell.
 */
const EXTRACT_ALL_LIST_CARDS_SCRIPT = `(function (cardSel) {
  function text(el) {
    if (!el || !el.textContent) return "";
    return el.textContent.replace(/\\s+/g, " ").trim();
  }
  var topSel = 'div[class*="TraffixBox-TopBox"]';
  var contentSel = 'div[class*="TraffixBox-Content"]';
  var anchors = Array.prototype.slice.call(document.querySelectorAll(cardSel));
  var out = [];
  for (var i = 0; i < anchors.length; i++) {
    var shell = anchors[i];
    var href = shell.getAttribute("href") || "";
    var title = "";
    var dateTexts = [];
    var top = shell.querySelector(topSel);
    if (top) {
      var bits = top.querySelectorAll("p, span");
      var texts = [];
      for (var j = 0; j < bits.length; j++) {
        var t = text(bits[j]);
        if (t) texts.push(t);
      }
      if (texts.length) {
        title = texts[0];
        for (var k = 1; k < texts.length; k++) dateTexts.push(texts[k]);
      }
      if (!title) title = text(top);
    }
    if (!title) {
      var innerContent = shell.querySelector(contentSel);
      if (innerContent) {
        var fp = innerContent.querySelector("p, span");
        if (fp) title = text(fp);
      }
    }
    if (!title) {
      var p0 = shell.querySelector("p");
      title = text(p0);
    }
    out.push({ listIndex: i, href: href, title: title, dateTexts: dateTexts });
  }
  return out;
})(${JSON.stringify(CARD_LINK_SEL)})`;

async function extractAllListCards(page: Page): Promise<ListCardRow[]> {
  const raw = await page.evaluate(EXTRACT_ALL_LIST_CARDS_SCRIPT);
  return raw as ListCardRow[];
}

function formatDateField(dateTexts: string[]): string | undefined {
  const j = dateTexts.join(" | ").trim();
  return j || undefined;
}

/**
 * דף פרטים: TopBox = כותרת + תאריכי התחלה/סיום; Content = תיאור + קווים מתתי־MuiBox בתוך האזור.
 */
const DETAIL_PAGE_EXTRACT_SCRIPT = `(function () {
  function text(el) {
    if (!el || !el.textContent) return "";
    return el.textContent.replace(/\\s+/g, " ").trim();
  }
  var topSel = 'div[class*="TraffixBox-TopBox"]';
  var contentSel = 'div[class*="TraffixBox-Content"]';

  var title = "";
  var effectiveStart = "";
  var effectiveEnd = "";
  var topBox = document.querySelector(topSel);
  if (topBox) {
    var bits = topBox.querySelectorAll("p, span");
    var texts = [];
    for (var i = 0; i < bits.length; i++) {
      var t = text(bits[i]);
      if (t) texts.push(t);
    }
    if (texts.length) {
      title = texts[0];
      if (texts.length > 1) effectiveStart = texts[1];
      if (texts.length > 2) effectiveEnd = texts[2];
      else if (texts.length === 2) effectiveEnd = "";
    }
    if (!title) title = text(topBox);
  }
  if (!title) {
    var h1 = document.querySelector("h1");
    if (h1) title = text(h1);
  }

  var fullDescription = "";
  var lineNumbers = [];
  var contentRoot = document.querySelector(contentSel);
  if (contentRoot) {
    var lineCandidates = contentRoot.querySelectorAll('div[class*="MuiBox-root"]');
    var seen = {};
    for (var k = 0; k < lineCandidates.length; k++) {
      var bt = text(lineCandidates[k]);
      if (!bt || bt.length > 32) continue;
      var lone = bt.match(/^\\s*(\\d{1,4})\\s*$/);
      if (lone) {
        var d0 = lone[1];
        if (!seen[d0]) {
          seen[d0] = true;
          lineNumbers.push(d0);
        }
        continue;
      }
      var nums = bt.match(/\\b\\d{1,4}\\b/g);
      if (!nums || nums.length > 3) continue;
      for (var m = 0; m < nums.length; m++) {
        var d = nums[m];
        if (!seen[d]) {
          seen[d] = true;
          lineNumbers.push(d);
        }
      }
    }
    lineNumbers.sort(function (a, b) { return Number(a) - Number(b); });

    var descRoot = contentRoot.cloneNode(true);
    var strip = descRoot.querySelectorAll('div[class*="MuiBox-root"]');
    for (var s = 0; s < strip.length; s++) {
      var node = strip[s];
      if (node.parentNode) node.parentNode.removeChild(node);
    }
    fullDescription = text(descRoot);
    if (!fullDescription) fullDescription = text(contentRoot);
  }

  if (!fullDescription) {
    var md = document.querySelector(".message-details");
    if (md) fullDescription = text(md);
  }

  return {
    title: title,
    effectiveStart: effectiveStart,
    effectiveEnd: effectiveEnd,
    fullDescription: fullDescription,
    lineNumbers: lineNumbers
  };
})()`;

export interface EggedDetailExtract {
  title: string;
  effectiveStart: string;
  effectiveEnd: string;
  fullDescription: string;
  lineNumbers: string[];
}

async function extractDetailPage(page: Page, url: string): Promise<EggedDetailExtract> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 800));

  const raw = await page.evaluate(DETAIL_PAGE_EXTRACT_SCRIPT);
  return raw as EggedDetailExtract;
}

function buildNormalizedAlert(
  card: ListCardRow,
  detailUrl: string,
  detail: EggedDetailExtract
): NormalizedAlert {
  const title = (detail.title || card.title).trim() || "התראה";
  const body =
    detail.fullDescription.trim() ||
    formatDateField(card.dateTexts) ||
    card.title ||
    title;

  const start =
    detail.effectiveStart.trim() ||
    (card.dateTexts[0]?.trim() ?? "") ||
    formatDateField(card.dateTexts);
  const end = detail.effectiveEnd.trim() || card.dateTexts[1]?.trim() || undefined;

  const dateJoined = [start, end].filter(Boolean).join(" | ") || formatDateField(card.dateTexts);

  const contentId = eggedContentIdFromDetailUrl(detailUrl);
  return {
    title,
    content: body,
    effectiveStart: start || undefined,
    effectiveEnd: end || undefined,
    operatorLabel: "אגד",
    detailUrl,
    meta: {
      fullDescription: body,
      link: detailUrl,
      lineNumbers: detail.lineNumbers,
      date: dateJoined ? dateJoined : null,
      listIndex: card.listIndex,
      ...(contentId ? { contentId } : {}),
    },
  };
}

export async function runEggedScan(
  _context?: ScraperRunContext
): Promise<EggedScrapingResult> {
  const scrapedAt = new Date().toISOString();

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;

  try {
    const launchOpts = buildPuppeteerLaunchOptions(["--disable-gpu"]);
    console.log(
      `Egged: puppeteer launch — executable=${launchOpts.executablePath ?? "(bundled)"}`
    );
    browser = await puppeteer.launch(launchOpts);

    const page = await browser.newPage();
    await applyPageDefaults(page);

    await page.goto(LIST_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await waitMuiSettleMs(MUI_SETTLE_MS);

    await page.screenshot({ path: DEBUG_SCREENSHOT_FILE, fullPage: true });
    console.log(`Egged: saved debug screenshot → ${DEBUG_SCREENSHOT_FILE}`);

    const shellCount = await evalCardCount(page, CARD_LINK_SEL);
    console.log(
      `Egged: Found ${shellCount} containers using StyledContainer selector.`
    );

    const loadMoreClicks = await grindLoadAll(page);
    const queue = await extractAllListCards(page);
    const total = queue.length;

    const detailPage = await browser.newPage();
    await applyPageDefaults(detailPage);

    const alerts: NormalizedAlert[] = [];
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < queue.length; i++) {
      const card = queue[i]!;
      const n = i + 1;
      const detailUrl = absoluteEggedUrl(card.href);

      try {
        const detail = await extractDetailPage(detailPage, detailUrl);
        alerts.push(buildNormalizedAlert(card, detailUrl, detail));
        successCount++;
        console.log(`Egged: Processing card ${n} of ${total}... Success`);
      } catch {
        failCount++;
        console.log(`Egged: Processing card ${n} of ${total}... Fail`);
        const fallbackDesc =
          [card.dateTexts.join(" | "), card.title].filter(Boolean).join("\n") || "";
        const partial = buildNormalizedAlert(card, detailUrl, {
          title: card.title,
          effectiveStart: card.dateTexts[0] ?? "",
          effectiveEnd: card.dateTexts[1] ?? "",
          fullDescription: fallbackDesc,
          lineNumbers: [],
        });
        partial.meta = { ...partial.meta, detailScrapeFailed: true };
        alerts.push(partial);
      }
    }

    await detailPage.close();
    await browser.close();
    browser = undefined;

    console.log(
      `Egged: Direct scan complete — ${total} cards queued, ${successCount} deep OK, ${failCount} failed.`
    );

    return {
      sourceId: "egged",
      displayName: DISPLAY_NAME,
      success: true,
      scrapedAt,
      alerts,
      meta: {
        listUrl: LIST_URL,
        queueLength: total,
        successCount,
        failCount,
        loadMoreClicks,
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
      sourceId: "egged",
      displayName: DISPLAY_NAME,
      success: false,
      scrapedAt,
      alerts: [],
      error: msg,
      meta: { listUrl: LIST_URL },
    };
  }
}

export async function runScan(
  context?: ScraperRunContext
): Promise<SourceScanResult> {
  return runEggedScan(context);
}

export const eggedScraper: AgencyScraper = {
  sourceId: "egged",
  displayName: DISPLAY_NAME,
  runScan,
};// trigger build 1
