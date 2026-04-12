/**
 * CLI dashboard: run one agency scraper or all in sequence.
 *
 * Usage (from repo root):
 *   pnpm --filter @workspace/scraper run scan -- --agency=egged
 *   pnpm --filter @workspace/scraper run scan -- --agency busnearby
 *   pnpm --filter @workspace/scraper run scan -- --all
 *
 * npm/pnpm (from repo root):
 *   pnpm --filter @workspace/scraper run scan -- --agency=dan
 *   pnpm --filter @workspace/scraper run scan -- --all
 */

import { createHash } from "node:crypto";
import { writeFile } from "fs/promises";

import {
  mergeScanResultsForEmail,
  sendBusAlertsSummaryEmail,
} from "./email-notifier";
import {
  ensureRepoDataDir,
  EGGED_ALERTS_JSON,
  loadRootEnv,
} from "./repo-paths";
import { rebuildScanExportAndMasterBusAlerts } from "./lib/alerts-collector.js";
import { mergeAndSaveAgencyAlertsFile } from "./lib/agency-alerts-store.js";
import {
  hydrateAgencyAlertFilesFromGcs,
  hydrateScanExportFromGcsIfConfigured,
} from "./gcs-sync.js";
import { logScraperProgressLine } from "./scrape-progress";
import { ALL_AGENCY_IDS, type KnownAgencyId, type SourceScanResult } from "./scrapers/types";
import { getScraper, isKnownAgencyId } from "./scrapers/registry";

loadRootEnv();

function parseCli(argv: string[]): {
  agency: string | null;
  all: boolean;
} {
  let agency: string | null = null;
  let all = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--all" || a === "-a") {
      all = true;
      continue;
    }
    const eq = a.match(/^--agency=(.+)$/);
    if (eq) {
      agency = eq[1]!;
      continue;
    }
    if (a === "--agency" && argv[i + 1]) {
      agency = argv[i + 1]!;
      i++;
    }
  }

  return { agency, all };
}

function printSummary(r: SourceScanResult) {
  const line = {
    source: r.sourceId,
    ok: r.success,
    alerts: r.alerts.length,
    error: r.error ?? null,
  };
  console.log(JSON.stringify(line, null, 2));
}

/** פורמט scripts/egged-alerts.json — כמו aggregate-transport-json alertsFromEggedJson */
function buildEggedAlertsJsonBag(
  alerts: SourceScanResult["alerts"]
): Record<string, Record<string, unknown>> {
  const bag: Record<string, Record<string, unknown>> = {};
  for (const a of alerts) {
    const link = (a.detailUrl ?? "").trim();
    const fromMeta =
      typeof a.meta?.contentId === "string" ? a.meta.contentId.trim() : "";
    const m = link.match(/\/traffic-updates\/(\d+)/i);
    const cid =
      fromMeta ||
      (m?.[1] ?? "").trim() ||
      createHash("sha256")
        .update(`${a.title}\0${link}`)
        .digest("hex")
        .slice(0, 16);
    const lines = Array.isArray(a.meta?.lineNumbers)
      ? (a.meta!.lineNumbers as unknown[]).map((x) => String(x))
      : [];
    const start = a.effectiveStart ?? "";
    const end = a.effectiveEnd ?? "";
    const effectiveJoined =
      start && end && start !== end ? `${start} | ${end}` : start || end || "";
    bag[cid] = {
      contentId: cid,
      title: a.title,
      content: a.content,
      detailUrl: link || "https://www.egged.co.il",
      effectiveStart: effectiveJoined,
      lineNumbers: lines,
    };
  }
  return bag;
}

/**
 * Per-agency alerts-*.json merge + collector rebuild of scan-export.json + bus-alerts.json.
 */
async function persistAgencyIsolationAndMaster(
  results: SourceScanResult[]
): Promise<void> {
  await ensureRepoDataDir();
  for (const r of results) {
    await mergeAndSaveAgencyAlertsFile(r);
  }
  await rebuildScanExportAndMasterBusAlerts();

  const egged = results.find((r) => r.sourceId === "egged" && r.success);
  if (egged) {
    const eggPayload = {
      scrapedAt: egged.scrapedAt,
      alerts: buildEggedAlertsJsonBag(egged.alerts),
    };
    await writeFile(EGGED_ALERTS_JSON, JSON.stringify(eggPayload, null, 2), "utf-8");
    console.log(`Wrote Egged JSON: ${EGGED_ALERTS_JSON}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { agency, all } = parseCli(argv);

  if (!all && !agency) {
    console.error(`Usage: --agency=<id> | --agency <id> | --all\n`);
    console.error(`Known agencies: ${ALL_AGENCY_IDS.join(", ")}\n`);
    console.error(
      `Example: pnpm --filter @workspace/scraper run scan -- --agency=egged`
    );
    process.exit(1);
  }

  if (!all && agency && !isKnownAgencyId(agency)) {
    console.error(`Unknown agency id: ${agency}`);
    console.error(`Known: ${ALL_AGENCY_IDS.join(", ")}`);
    process.exit(1);
  }

  const ids: KnownAgencyId[] = all ? [...ALL_AGENCY_IDS] : [agency as KnownAgencyId];

  await ensureRepoDataDir();
  await hydrateScanExportFromGcsIfConfigured();
  await hydrateAgencyAlertFilesFromGcs();

  /** סריקת --all: מייל מאוחד בסוף; סריקת סוכן יחיד: המייל יוצא מהסקרייפר (או מהאורקסטרטור עבור מקורות בלי מייל פנימי) */
  const isFullRun = all;
  /** כשמופעל (למשל מ־Next proxy-scan) — אין מיילים מהאורקסטרטור/סקרייפרים */
  const skipAllEmails =
    process.env.SCRAPER_ORCHESTRATOR_SKIP_ALL_EMAIL === "1" ||
    process.env.SCRAPER_ORCHESTRATOR_SKIP_ALL_EMAIL === "true";

  let failures = 0;
  const results: SourceScanResult[] = [];

  let agencyIndex = 0;
  for (const id of ids) {
    const scraper = getScraper(id);
    if (!scraper) {
      console.error(`Unknown agency id: ${id}`);
      failures++;
      continue;
    }

    agencyIndex++;
    console.log(`\n────────── ${scraper.displayName} (${scraper.sourceId}) ──────────`);
    const result = await scraper.runScan({
      forwardArgv: argv.slice(),
      suppressEmail: isFullRun || skipAllEmails,
    });
    results.push(result);
    printSummary(result);
    if (!result.success) failures++;
    const status = result.success ? "OK" : "FAILED";
    console.log(
      `[Orchestrator] Finished ${scraper.displayName} (${scraper.sourceId}) — ${status}`
    );
    logScraperProgressLine({
      agency: scraper.sourceId,
      displayName: scraper.displayName,
      current: agencyIndex,
      total: ids.length,
      alertsFound: result.alerts.length,
    });
  }

  await persistAgencyIsolationAndMaster(results);

  if (!skipAllEmails) {
    if (isFullRun) {
      const mergedEmail = mergeScanResultsForEmail(results);
      if (mergedEmail) {
        await sendBusAlertsSummaryEmail(mergedEmail, { groupCatalogByProvider: true });
      }
    } else {
      const onlyId = ids[0];
      if (onlyId === "busnearby") {
        console.log(
          "Orchestrator: single Bus Nearby run — the scraper sends the email (when SMTP is configured); orchestrator does not send a second message."
        );
      } else if (onlyId === "kavim") {
        console.log(
          "Orchestrator: single Kavim run — the scraper sends its own email (when SMTP is configured); orchestrator does not send a second merged message."
        );
      } else if (onlyId === "dan") {
        console.log(
          "Orchestrator: single Dan run — the scraper sends its own email (when SMTP is configured); orchestrator does not send a second merged message."
        );
      } else {
        const singleEmail = mergeScanResultsForEmail(results);
        if (singleEmail) {
          await sendBusAlertsSummaryEmail(singleEmail, { groupCatalogByProvider: false });
        }
      }
    }
  }

  if (failures > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
