/**
 * מטרופולין — דף עדכונים יחיד: https://www.metropoline.com/updates
 * ללא ניווט: כל התוכן ב־DOM (כולל div.up_info_gr).
 */

import { createHash } from "node:crypto";
import puppeteer, { type Page } from "puppeteer";

import type {
  AgencyScraper,
  NormalizedAlert,
  ScraperRunContext,
  SourceScanResult,
} from "../types";
import { launchPuppeteerBrowser } from "../puppeteer-helpers";

const LIST_URL =
  process.env.METROPOLINE_ALERTS_URL?.trim() || "https://www.metropoline.com/updates";

const DISPLAY_NAME = "מטרופולין";
const PROVIDER_LABEL = "מטרופולין";

const METRO_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SETTLE_MS = 2500;

/**
 * מחרוזת בלבד ל־evaluate — מונע הזרקת __name מ־tsx/esbuild.
 */
const METRO_EXTRACT_SCRIPT = `(function () {
  function text(el) {
    if (!el || !el.textContent) return "";
    return el.textContent.replace(/\\s+/g, " ").trim();
  }
  var out = [];
  var sections = Array.prototype.slice.call(document.querySelectorAll("div.cluster-section"));
  for (var s = 0; s < sections.length; s++) {
    var sec = sections[s];
    var ct = sec.querySelector("h3.cluster-title");
    var clusterTitle = ct ? text(ct) : "";
    var blocks = sec.querySelectorAll("div.update_block");
    for (var b = 0; b < blocks.length; b++) {
      var ub = blocks[b];
      var titEl = ub.querySelector("div.update_title_block");
      var rawTitle = titEl ? text(titEl) : "";
      var lines = [];
      var gr = ub.querySelector("div.update_title_gr");
      if (gr) {
        var ul = gr.querySelector("ul.sm_line_list");
        if (ul) {
          var lis = ul.querySelectorAll("li");
          for (var li = 0; li < lis.length; li++) {
            var lt = text(lis[li]);
            if (lt) lines.push(lt);
          }
        }
      }
      var infoGr = ub.querySelector("div.up_info_gr");
      var fullContent = infoGr ? text(infoGr) : "";
      var blockText = text(ub);
      var dateStr = "";
      var dm = blockText.match(/בתוקף[^\\n]*/);
      if (dm) dateStr = dm[0].trim();
      out.push({
        clusterTitle: clusterTitle,
        rawTitle: rawTitle,
        lines: lines,
        fullContent: fullContent,
        dateStr: dateStr
      });
    }
  }
  return out;
})()`;

interface RawMetroRow {
  clusterTitle: string;
  rawTitle: string;
  lines: string[];
  fullContent: string;
  dateStr: string;
}

function dedupeFingerprint(title: string, content: string, lines: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([title, content, lines]))
    .digest("hex");
}

function buildDisplayTitle(clusterTitle: string, rawTitle: string): string {
  const t = rawTitle.trim() || "עדכון";
  const c = clusterTitle.trim();
  if (!c) return t;
  return "[" + c + "] " + t;
}

async function applyPageDefaults(page: Page): Promise<void> {
  await page.setUserAgent(METRO_MAC_UA);
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
}

export async function runScan(context?: ScraperRunContext): Promise<SourceScanResult> {
  void context?.suppressEmail;

  const scrapedAt = new Date().toISOString();

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;

  try {
    browser = await launchPuppeteerBrowser();

    const page = await browser.newPage();
    await applyPageDefaults(page);

    await page.goto(LIST_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    const raw = (await page.evaluate(METRO_EXTRACT_SCRIPT)) as RawMetroRow[];
    await browser.close();
    browser = undefined;

    const seen = new Set<string>();
    const alerts: NormalizedAlert[] = [];

    for (const row of raw) {
      const title = buildDisplayTitle(row.clusterTitle, row.rawTitle);
      const content = row.fullContent.trim() || row.rawTitle.trim() || title;
      const lines = row.lines.map((x) => String(x).trim()).filter(Boolean);
      if (!content && !row.rawTitle.trim()) continue;

      const fp = dedupeFingerprint(title, content, lines);
      if (seen.has(fp)) continue;
      seen.add(fp);

      alerts.push({
        title,
        content,
        effectiveStart: row.dateStr || undefined,
        operatorLabel: PROVIDER_LABEL,
        detailUrl: LIST_URL,
        meta: {
          lineNumbers: lines,
          fullDescription: content,
          clusterTitle: row.clusterTitle || null,
          contentFingerprint: fp,
          link: LIST_URL,
        },
      });
    }

    return {
      sourceId: "metropoline",
      displayName: DISPLAY_NAME,
      success: true,
      scrapedAt,
      alerts,
      meta: { listUrl: LIST_URL, extracted: alerts.length, rawBlocks: raw.length },
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
      sourceId: "metropoline",
      displayName: DISPLAY_NAME,
      success: false,
      scrapedAt,
      alerts: [],
      error: msg,
      meta: { listUrl: LIST_URL },
    };
  }
}

export const metropolineScraper: AgencyScraper = {
  sourceId: "metropoline",
  displayName: DISPLAY_NAME,
  runScan,
};
