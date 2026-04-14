/**
 * HTML email notifications for bus alerts (nodemailer only — no Slack/Telegram/desktop).
 */

import nodemailer from "nodemailer";

import type { NormalizedAlert, SourceScanResult } from "./scrapers/types";

const BASE_URL = "https://www.busnearby.co.il";

export const BUSNEARBY_EMAIL_PAYLOAD_META_KEY = "busnearbyEmailPayload";

export interface EmailRouteRef {
  patternUrl: string;
  patternId: string;
  apiRouteId: string;
  agencyFilterIds: string[];
}

export interface EmailDedupedAlert {
  contentId: string;
  title: string;
  fullContent: string;
  routes: EmailRouteRef[];
  /** אם מוגדר — מוצג בעמודת "מפעיל" (אגד, Bus Nearby, וכו׳) */
  providerDisplay?: string;
}

/** Payload שנשמר ב-meta של תוצאת busnearby כשמדכאים שליחה מהסקרייפר */
export interface BusnearbyEmailPayload {
  scrapedAt: string;
  added: EmailDedupedAlert[];
  removed: EmailDedupedAlert[];
  allAlerts: EmailDedupedAlert[];
  lineByPatternId: Record<string, string>;
  agencyLabelById: Record<string, string>;
  routesInDb: number;
  routesQueued: number;
  routesSkippedFresh: number;
  okCount: number;
  failCount: number;
  scanStaleAfterHours: number;
}

export interface SendBusAlertsEmailOptions {
  scrapedAt: string;
  added: EmailDedupedAlert[];
  removed: EmailDedupedAlert[];
  allAlerts: EmailDedupedAlert[];
  lineByPatternId: Record<string, string>;
  agencyLabelById: Record<string, string>;
  routesInDb: number;
  routesQueued: number;
  routesSkippedFresh: number;
  okCount: number;
  failCount: number;
  scanStaleAfterHours: number;
}

/** אפשרויות תצוגה בשליחת המייל (מצב מאוחד מול ספציפי) */
export interface BusAlertsEmailSendOptions {
  /** true = סריקת --all: טבלאות קטלוג מקובצות לפי שם מפעיל */
  groupCatalogByProvider?: boolean;
  /** אם מוגדר — דורס את נושא המייל (דוח סוכן בודד, למשל דן) */
  subjectOverride?: string;
}

const DESCRIPTION_MAX_CHARS = 4000;

/** מספר התראות מקסימלי בגוף המייל ובקובץ ה-CSV המצורף (תואם לטבלאות ב-HTML) */
const BUS_ALERTS_EMAIL_CATALOG_CAP = 80;

const UTF8_BOM = "\uFEFF";

const CSV_COLUMNS_EN =
  "Provider,Title,Lines,Start Date,End Date,Full Content,Link";

/** תאריך YYYY-MM-DD מתוך ISO של הסריקה (לשם קובץ מצורף) */
function dateStampFromScrapedAt(scrapedAt: string): string {
  const head = scrapedAt.trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(head)) return head;
  try {
    return new Date(scrapedAt).toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function escapeCsvField(value: string): string {
  const t = String(value ?? "");
  if (/[",\r\n]/.test(t)) {
    return `"${t.replace(/"/g, '""')}"`;
  }
  return t;
}

function csvRow(cells: string[]): string {
  return cells.map(escapeCsvField).join(",");
}

/**
 * ממיר NormalizedAlert[] למחרוזת CSV (UTF-8 עם BOM לפתיחה נכונה ב-Excel).
 * עמודות: Provider, Title, Lines, Start Date, End Date, Full Content, Link.
 * מערך lineNumbers מוצג כמחרוזת מופרדת בפסיקים בתוך התא.
 */
export function normalizedAlertsToCsvString(alerts: NormalizedAlert[]): string {
  const rows = [CSV_COLUMNS_EN];
  for (const a of alerts) {
    const provider = a.operatorLabel?.trim() ?? "";
    const title = a.title?.trim() ?? "";
    const lines = Array.isArray(a.meta?.lineNumbers)
      ? (a.meta!.lineNumbers as string[])
          .map((x) => String(x).trim())
          .filter(Boolean)
          .join(", ")
      : "";
    const startDate = a.effectiveStart?.trim() ?? "";
    const endDate = a.effectiveEnd?.trim() ?? "";
    const fullContent =
      (typeof a.meta?.fullDescription === "string" && a.meta.fullDescription.trim()) ||
      a.content?.trim() ||
      "";
    const link = a.detailUrl?.trim() ?? "";
    rows.push(
      csvRow([provider, title, lines, startDate, endDate, fullContent, link])
    );
  }
  return UTF8_BOM + rows.join("\r\n");
}

const CSV_ATTACHMENT_NOTE_HTML = `<p style="font-family:system-ui,Arial,sans-serif;color:#666;font-size:13px;margin-top:24px;">מצורף קובץ CSV עם ריכוז כל ההתראות לנוחיותך</p>`;

const CSV_ATTACHMENT_NOTE_TEXT =
  "מצורף קובץ CSV עם ריכוז כל ההתראות לנוחיותך.";

function appendCsvNoteToHtml(html: string): string {
  return html.replace("</body></html>", `${CSV_ATTACHMENT_NOTE_HTML}</body></html>`);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncateForEmail(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "…";
}

function safeHref(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return "#";
    return escapeHtml(u.href);
  } catch {
    return "#";
  }
}

function operatorCell(
  alert: EmailDedupedAlert,
  routes: EmailRouteRef[],
  agencyLabelById: Record<string, string>
): string {
  if (alert.providerDisplay?.trim()) return alert.providerDisplay.trim();
  const ids = new Set<string>();
  for (const r of routes) {
    for (const id of r.agencyFilterIds) ids.add(id);
  }
  const labels = [...ids].sort(
    (a, b) => Number(a) - Number(b) || a.localeCompare(b)
  ).map((id) => agencyLabelById[id] ?? `מפעיל ${id}`);
  return labels.join(", ") || "—";
}

function linesCell(routes: EmailRouteRef[], lineByPatternId: Record<string, string>): string {
  const parts = routes.map((r) => {
    const hint = lineByPatternId[r.patternId]?.trim();
    return hint || r.apiRouteId;
  });
  return [...new Set(parts)].join(", ");
}

function detailUrlForAlert(a: EmailDedupedAlert): string {
  const u = a.routes[0]?.patternUrl;
  return u && u.startsWith("http") ? u : BASE_URL;
}

/** אותן עמודות כמו normalizedAlertsToCsvString, ממודל הדוא״ל המאוחד (Bus Nearby + מיזוג) */
function emailDedupedAlertsToCsvString(
  alerts: EmailDedupedAlert[],
  lineByPatternId: Record<string, string>,
  agencyLabelById: Record<string, string>
): string {
  const rows = [CSV_COLUMNS_EN];
  for (const alert of alerts) {
    const provider = operatorCell(alert, alert.routes, agencyLabelById);
    const title = alert.title?.trim() ?? "";
    const lines = linesCell(alert.routes, lineByPatternId);
    const fullContent = alert.fullContent?.trim() ?? "";
    const link = detailUrlForAlert(alert);
    rows.push(csvRow([provider, title, lines, "", "", fullContent, link]));
  }
  return UTF8_BOM + rows.join("\r\n");
}

function titleAndDescriptionCell(alert: EmailDedupedAlert): string {
  const title = alert.title || "(ללא כותרת)";
  const body = truncateForEmail(alert.fullContent || "", DESCRIPTION_MAX_CHARS);
  return `<div style="font-weight:600;margin-bottom:6px;">${escapeHtml(title)}</div>
<div style="color:#333;font-size:13px;line-height:1.45;white-space:pre-wrap;">${escapeHtml(body)}</div>`;
}

function buildTableRows(
  rows: { kind: string; alert: EmailDedupedAlert }[],
  lineByPatternId: Record<string, string>,
  agencyLabelById: Record<string, string>
): string {
  if (rows.length === 0) {
    return `<tr><td colspan="5" style="padding:12px;">אין רשומות</td></tr>`;
  }
  return rows
    .map(({ kind, alert }) => {
      const href = safeHref(detailUrlForAlert(alert));
      return `<tr style="vertical-align:top;">
  <td style="padding:10px;border:1px solid #ccc;">${escapeHtml(kind)}</td>
  <td style="padding:10px;border:1px solid #ccc;">${escapeHtml(
    operatorCell(alert, alert.routes, agencyLabelById)
  )}</td>
  <td style="padding:10px;border:1px solid #ccc;">${escapeHtml(
    linesCell(alert.routes, lineByPatternId)
  )}</td>
  <td style="padding:10px;border:1px solid #ccc;">${titleAndDescriptionCell(alert)}</td>
  <td style="padding:10px;border:1px solid #ccc;"><a href="${href}" style="color:#0b57d0;">פרטים</a></td>
</tr>`;
    })
    .join("\n");
}

const TABLE_HEADERS = `<th style="padding:10px;border:1px solid #166534;text-align:right;">סוג</th>
<th style="padding:10px;border:1px solid #166534;text-align:right;">מפעיל</th>
<th style="padding:10px;border:1px solid #166534;text-align:right;">מספרי קווים</th>
<th style="padding:10px;border:1px solid #166534;text-align:right;">כותרת ותיאור</th>
<th style="padding:10px;border:1px solid #166534;text-align:right;">קישור</th>`;

function wrapTable(bodyRows: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:900px;font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;">
<thead>
<tr style="background:#14532d;color:#fff;">
${TABLE_HEADERS}
</tr>
</thead>
<tbody>
${bodyRows}
</tbody>
</table>`;
}

function buildStatsHtml(opts: SendBusAlertsEmailOptions): string {
  return `<p style="font-family:system-ui,Arial,sans-serif;color:#333;">
<strong>זמן ריצה:</strong> ${escapeHtml(opts.scrapedAt)}<br/>
<strong>קווים ב־DB (אוטובוסים בלבד):</strong> ${opts.routesInDb} |
<strong>נסרקו עכשיו:</strong> ${opts.routesQueued} (הצלחה ${opts.okCount}, כשל ${opts.failCount}) |
<strong>דולגו (טריים &lt;${opts.scanStaleAfterHours}ש׳):</strong> ${opts.routesSkippedFresh}<br/>
<strong>רכבת ישראל (מפעיל 2):</strong> מוחרג לצמיתות מהסריקה ומהמסד.<br/>
<strong>סה״כ התראות בדוח (מאוחד):</strong> ${opts.allAlerts.length}
</p>`;
}

function providerGroupKey(alert: EmailDedupedAlert): string {
  return alert.providerDisplay?.trim() || "אחר";
}

/** סדר יציב: לפי סדר הופעה ב־allSlice, אבל כותרות ממוינות בעברית */
function groupAlertsByProviderOrdered(slice: EmailDedupedAlert[]): Map<string, EmailDedupedAlert[]> {
  const order: string[] = [];
  const map = new Map<string, EmailDedupedAlert[]>();
  for (const a of slice) {
    const k = providerGroupKey(a);
    if (!map.has(k)) {
      map.set(k, []);
      order.push(k);
    }
    map.get(k)!.push(a);
  }
  const sortedKeys = [...order].sort((a, b) => a.localeCompare(b, "he"));
  const out = new Map<string, EmailDedupedAlert[]>();
  for (const k of sortedKeys) out.set(k, map.get(k)!);
  return out;
}

function buildCatalogTablesHtml(
  opts: SendBusAlertsEmailOptions,
  allSlice: EmailDedupedAlert[],
  groupByProvider: boolean
): string {
  if (allSlice.length === 0) {
    return wrapTable(
      buildTableRows([], opts.lineByPatternId, opts.agencyLabelById)
    );
  }
  if (!groupByProvider) {
    const allRows = allSlice.map((a) => ({ kind: "נוכחי", alert: a }));
    return wrapTable(buildTableRows(allRows, opts.lineByPatternId, opts.agencyLabelById));
  }
  const parts: string[] = [];
  for (const [provider, alerts] of groupAlertsByProviderOrdered(allSlice)) {
    parts.push(
      `<h3 style="font-family:system-ui,Arial,sans-serif;color:#166534;margin:20px 0 8px 0;border-bottom:2px solid #bbf7d0;padding-bottom:6px;">${escapeHtml(provider)} <span style="color:#666;font-weight:400;">(${alerts.length})</span></h3>`
    );
    const rows = alerts.map((a) => ({ kind: "נוכחי", alert: a }));
    parts.push(wrapTable(buildTableRows(rows, opts.lineByPatternId, opts.agencyLabelById)));
  }
  return parts.join("\n");
}

function buildCatalogTextLines(
  opts: SendBusAlertsEmailOptions,
  allSlice: EmailDedupedAlert[],
  groupByProvider: boolean
): string[] {
  if (!groupByProvider) {
    return allSlice.map(
      (alert) =>
        `${operatorCell(alert, alert.routes, opts.agencyLabelById)}: ${alert.title} | קווים: ${linesCell(alert.routes, opts.lineByPatternId)}`
    );
  }
  const lines: string[] = [];
  for (const [provider, alerts] of groupAlertsByProviderOrdered(allSlice)) {
    lines.push(`—— ${provider} (${alerts.length}) ——`);
    for (const alert of alerts) {
      lines.push(
        `  ${alert.title} | קווים: ${linesCell(alert.routes, opts.lineByPatternId)}`
      );
    }
  }
  return lines;
}

function buildHtmlBody(
  opts: SendBusAlertsEmailOptions,
  sendOpts?: BusAlertsEmailSendOptions
): { html: string; text: string } {
  const groupCatalog = sendOpts?.groupCatalogByProvider === true;
  const hasDiff = opts.added.length > 0 || opts.removed.length > 0;
  const hasCatalog = opts.allAlerts.length > 0;
  const statsHtml = buildStatsHtml(opts);

  if (!hasDiff && !hasCatalog) {
    const html = `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8"/></head><body style="background:#f6f7f9;padding:24px;">
${statsHtml}
<p style="font-size:16px;color:#14532d;font-weight:600;">סריקת האוטובוסים הושלמה - לא נמצאו שינויים חדשים</p>
</body></html>`;
    const text = `סריקת האוטובוסים הושלמה - לא נמצאו שינויים חדשים\nזמן: ${opts.scrapedAt}\nקווים ב-DB: ${opts.routesInDb}`;
    return { html, text };
  }

  const allCap = BUS_ALERTS_EMAIL_CATALOG_CAP;
  const allSlice = opts.allAlerts.slice(0, allCap);
  const catalogHtml = buildCatalogTablesHtml(opts, allSlice, groupCatalog);
  const more =
    opts.allAlerts.length > allCap
      ? `<p style="font-family:system-ui,Arial,sans-serif;color:#666;">ועוד ${opts.allAlerts.length - allCap} התראות — ראה קובץ bus-alerts.json / סורקים נוספים</p>`
      : "";

  const catalogHeading = groupCatalog
    ? `כל ההתראות לפי מפעיל (עד ${allCap} סה״כ)`
    : `כל ההתראות המאוחדות (עד ${allCap})`;

  if (!hasDiff && hasCatalog) {
    const html = `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8"/></head><body style="background:#f6f7f9;padding:24px;">
${statsHtml}
<h2 style="font-family:system-ui,Arial,sans-serif;color:#14532d;margin-top:8px;">${escapeHtml(catalogHeading)}</h2>
${catalogHtml}
${more}
</body></html>`;
    const text = [
      `דוח מאוחד: ${opts.allAlerts.length} התראות`,
      `זמן: ${opts.scrapedAt}`,
      "",
      ...buildCatalogTextLines(opts, allSlice, groupCatalog),
    ].join("\n");
    return { html, text };
  }

  const changeRows = [
    ...opts.added.map((a) => ({ kind: "חדש", alert: a })),
    ...opts.removed.map((a) => ({ kind: "הוסר", alert: a })),
  ];
  const changeBody = buildTableRows(changeRows, opts.lineByPatternId, opts.agencyLabelById);

  const html = `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8"/></head><body style="background:#f6f7f9;padding:24px;">
${statsHtml}
<h2 style="font-family:system-ui,Arial,sans-serif;color:#14532d;">שינויים מול הריצה הקודמת</h2>
${wrapTable(changeBody)}
<h2 style="font-family:system-ui,Arial,sans-serif;color:#14532d;margin-top:28px;">${escapeHtml(catalogHeading)}</h2>
${catalogHtml}
${more}
</body></html>`;

  const text = [
    `שינויים: +${opts.added.length} / -${opts.removed.length}`,
    `סה"כ התראות בדוח: ${opts.allAlerts.length}`,
    "",
    ...changeRows.map(
      ({ kind, alert }) =>
        `${kind}: ${operatorCell(alert, alert.routes, opts.agencyLabelById)} — ${alert.title} | ${linesCell(alert.routes, opts.lineByPatternId)}`
    ),
    "",
    ...buildCatalogTextLines(opts, allSlice, groupCatalog),
  ].join("\n");

  return { html, text };
}

export function normalizedAlertsToEmailDeduped(
  alerts: NormalizedAlert[],
  sourceId: string
): EmailDedupedAlert[] {
  return alerts.map((n, idx) => normalizedToEmailDeduped(n, sourceId, idx));
}

function normalizedToEmailDeduped(
  n: NormalizedAlert,
  sourceId: string,
  idx: number
): EmailDedupedAlert {
  const link = n.detailUrl?.trim() || BASE_URL;
  const lines = Array.isArray(n.meta?.lineNumbers)
    ? (n.meta!.lineNumbers as string[]).filter((x) => String(x).trim())
    : [];
  const fullContent =
    (typeof n.meta?.fullDescription === "string" && n.meta.fullDescription.trim()) ||
    (n.content && n.content.trim()) ||
    n.title ||
    "";
  const provider =
    n.operatorLabel?.trim() ||
    (sourceId === "egged" ? "אגד" : sourceId);
  const cid = `${sourceId}:${String(n.meta?.eggedContentId ?? n.meta?.contentId ?? "")}:${idx}`;
  return {
    contentId: cid.slice(0, 240),
    title: n.title?.trim() || "(ללא כותרת)",
    fullContent,
    providerDisplay: provider,
    routes:
      lines.length > 0
        ? lines.map((line, i) => ({
            patternUrl: link,
            patternId: `${sourceId}-L${i}-${line}`,
            apiRouteId: String(line),
            agencyFilterIds: [],
          }))
        : [
            {
              patternUrl: link,
              patternId: `${sourceId}-row-${idx}`,
              apiRouteId: "—",
              agencyFilterIds: [],
            },
          ],
  };
}

function emptyBusnearbyPayload(): BusnearbyEmailPayload {
  return {
    scrapedAt: new Date().toISOString(),
    added: [],
    removed: [],
    allAlerts: [],
    lineByPatternId: {},
    agencyLabelById: {},
    routesInDb: 0,
    routesQueued: 0,
    routesSkippedFresh: 0,
    okCount: 0,
    failCount: 0,
    scanStaleAfterHours: 12,
  };
}

/**
 * מאחד תוצאות סריקה (Bus Nearby payload + התראות Normalized ממקורות אחרים) לדוח מייל יחיד.
 */
export function mergeScanResultsForEmail(results: SourceScanResult[]): SendBusAlertsEmailOptions | null {
  const bn = results.find((r) => r.sourceId === "busnearby");
  const rawPayload = bn?.meta?.[BUSNEARBY_EMAIL_PAYLOAD_META_KEY];
  const payload: BusnearbyEmailPayload | null =
    rawPayload && typeof rawPayload === "object"
      ? (rawPayload as BusnearbyEmailPayload)
      : null;

  const extraRows: EmailDedupedAlert[] = [];
  for (const r of results) {
    if (r.sourceId === "busnearby" || !r.success || !r.alerts?.length) continue;
    extraRows.push(...normalizedAlertsToEmailDeduped(r.alerts, r.sourceId));
  }

  if (!payload && extraRows.length === 0) return null;

  const base = payload ?? emptyBusnearbyPayload();
  const allAlerts = [...base.allAlerts, ...extraRows];

  const scrapedAt =
    [...results.map((r) => r.scrapedAt)].sort().at(-1) ?? new Date().toISOString();

  return {
    scrapedAt,
    added: base.added,
    removed: base.removed,
    allAlerts,
    lineByPatternId: { ...base.lineByPatternId },
    agencyLabelById: { ...base.agencyLabelById },
    routesInDb: base.routesInDb,
    routesQueued: base.routesQueued,
    routesSkippedFresh: base.routesSkippedFresh,
    okCount: base.okCount,
    failCount: base.failCount,
    scanStaleAfterHours: base.scanStaleAfterHours,
  };
}

export async function sendBusAlertsSummaryEmail(
  opts: SendBusAlertsEmailOptions,
  sendOpts?: BusAlertsEmailSendOptions
): Promise<{ sent: boolean; to?: string }> {
  const host = process.env.BUS_ALERTS_SMTP_HOST?.trim();
  if (!host) {
    console.log("Email: skipped (set BUS_ALERTS_SMTP_HOST in .env)");
    return { sent: false };
  }

  const port = Number(process.env.BUS_ALERTS_SMTP_PORT ?? "587");
  const secure = process.env.BUS_ALERTS_SMTP_SECURE === "1";
  const user = process.env.BUS_ALERTS_SMTP_USER?.trim();
  const pass = process.env.BUS_ALERTS_SMTP_PASS ?? "";
  const from = process.env.BUS_ALERTS_EMAIL_FROM?.trim();
  const to = process.env.BUS_ALERTS_EMAIL_TO?.trim();

  if (!from || !to) {
    console.warn("Email: missing BUS_ALERTS_EMAIL_FROM or BUS_ALERTS_EMAIL_TO");
    return { sent: false };
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    ...(user ? { auth: { user, pass } } : {}),
  });
  const fromAddress = "מערכת ניטור תחבורה <avy.unge@gmail.com>";
  const listUnsub = "<mailto:avy.unge+unsubscribe@gmail.com?subject=unsubscribe>";

  let { html, text } = buildHtmlBody(opts, sendOpts);
  const hasDiff = opts.added.length > 0 || opts.removed.length > 0;
  const hasCatalog = opts.allAlerts.length > 0;
  const fullMerged = sendOpts?.groupCatalogByProvider === true;
  const override = sendOpts?.subjectOverride?.trim();
  const subject =
    override ||
    (!hasCatalog && !hasDiff
      ? "אוטובוסים: סריקה הושלמה — אין שינויים"
      : hasDiff
        ? `אוטובוסים: עדכון התראות (+${opts.added.length} / −${opts.removed.length})`
        : fullMerged
          ? `אוטובוסים: דוח מלא מאוחד לפי מפעיל (${opts.allAlerts.length})`
          : `אוטובוסים: דוח התראות (${opts.allAlerts.length})`);
  const subjectClean =
    sendOpts?.subjectOverride?.trim() ||
    `עדכון התראות תחבורה - ${
      subject.replace(/^אוטובוסים:\s*/u, "").trim() || "כלל הסוכנויות"
    } - ${dateStampFromScrapedAt(opts.scrapedAt)}`;

  const allSliceForCsv =
    !hasDiff && !hasCatalog ? [] : opts.allAlerts.slice(0, BUS_ALERTS_EMAIL_CATALOG_CAP);
  const csvString = emailDedupedAlertsToCsvString(
    allSliceForCsv,
    opts.lineByPatternId,
    opts.agencyLabelById
  );
  const csvFilename = `bus_alerts_${dateStampFromScrapedAt(opts.scrapedAt)}.csv`;

  html = appendCsvNoteToHtml(html);
  text = `${text}\n\n${CSV_ATTACHMENT_NOTE_TEXT}`;

  console.log(`Sending email with ${opts.allAlerts.length} alerts (CSV: ${allSliceForCsv.length} rows + header)`);

  await transporter.sendMail({
    from: fromAddress || from,
    to,
    replyTo: fromAddress,
    subject: subjectClean,
    text,
    html,
    headers: {
      "List-Unsubscribe": listUnsub,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    attachments: [
      {
        filename: csvFilename,
        content: csvString,
        contentType: "text/csv; charset=utf-8",
      },
    ],
  });

  return { sent: true, to };
}

const KAVIM_EMAIL_SUBJECT = "[קווים] עדכוני תנועה - סריקה אחרונה";

/**
 * דוח עצמאי לקווים (Kavim) — אותם משתני SMTP כמו דוח האוטובוסים.
 */
export async function sendKavimTrafficEmail(options: {
  scrapedAt: string;
  alerts: NormalizedAlert[];
}): Promise<{ sent: boolean; to?: string }> {
  const host = process.env.BUS_ALERTS_SMTP_HOST?.trim();
  if (!host) {
    console.log("Kavim email: skipped (set BUS_ALERTS_SMTP_HOST in .env)");
    return { sent: false };
  }

  const port = Number(process.env.BUS_ALERTS_SMTP_PORT ?? "587");
  const secure = process.env.BUS_ALERTS_SMTP_SECURE === "1";
  const user = process.env.BUS_ALERTS_SMTP_USER?.trim();
  const pass = process.env.BUS_ALERTS_SMTP_PASS ?? "";
  const from = process.env.BUS_ALERTS_EMAIL_FROM?.trim();
  const to = process.env.BUS_ALERTS_EMAIL_TO?.trim();

  if (!from || !to) {
    console.warn("Kavim email: missing BUS_ALERTS_EMAIL_FROM or BUS_ALERTS_EMAIL_TO");
    return { sent: false };
  }

  if (options.alerts.length === 0) {
    console.log("Kavim email: no alerts to send");
    return { sent: false };
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    ...(user ? { auth: { user, pass } } : {}),
  });

  const tableRows = options.alerts
    .map((a, i) => {
      const lines = Array.isArray(a.meta?.lineNumbers)
        ? (a.meta!.lineNumbers as string[]).join(" · ")
        : "—";
      const body = truncateForEmail(a.content || "", 3500);
      return `<tr style="vertical-align:top;">
  <td style="padding:10px;border:1px solid #ccc;">${escapeHtml(String(i + 1))}</td>
  <td style="padding:10px;border:1px solid #ccc;">${escapeHtml(a.title || "(ללא כותרת)")}</td>
  <td style="padding:10px;border:1px solid #ccc;">${escapeHtml(a.effectiveStart ?? "—")}</td>
  <td style="padding:10px;border:1px solid #ccc;">${escapeHtml(lines)}</td>
  <td style="padding:10px;border:1px solid #ccc;font-size:13px;white-space:pre-wrap;">${escapeHtml(body)}</td>
  <td style="padding:10px;border:1px solid #ccc;"><a href="${safeHref(a.detailUrl || "#")}" style="color:#0b57d0;">פתיחה</a></td>
</tr>`;
    })
    .join("\n");

  const html = `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8"/></head><body style="background:#f6f7f9;padding:24px;font-family:system-ui,Arial,sans-serif;">
<p style="color:#333;"><strong>קווים — עדכוני תנועה</strong><br/>
זמן סריקה: ${escapeHtml(options.scrapedAt)} · <strong>${options.alerts.length}</strong> התראות</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:960px;font-size:14px;">
<thead><tr style="background:#1e3a5f;color:#fff;">
<th style="padding:10px;border:1px solid #1e3a5f;">#</th>
<th style="padding:10px;border:1px solid #1e3a5f;">כותרת</th>
<th style="padding:10px;border:1px solid #1e3a5f;">תאריך</th>
<th style="padding:10px;border:1px solid #1e3a5f;">קווים / יעדים</th>
<th style="padding:10px;border:1px solid #1e3a5f;">תוכן</th>
<th style="padding:10px;border:1px solid #1e3a5f;">קישור</th>
</tr></thead>
<tbody>
${tableRows}
</tbody>
</table>
${CSV_ATTACHMENT_NOTE_HTML}
</body></html>`;

  const text = [
    `קווים — ${options.alerts.length} התראות`,
    `זמן: ${options.scrapedAt}`,
    "",
    ...options.alerts.map((a, i) => {
      const lines = Array.isArray(a.meta?.lineNumbers)
        ? (a.meta!.lineNumbers as string[]).join(", ")
        : "";
      return `${i + 1}. ${a.title}\n   תאריך: ${a.effectiveStart ?? ""}\n   קווים: ${lines}\n   ${truncateForEmail(a.content || "", 500)}\n   ${a.detailUrl ?? ""}`;
    }),
    "",
    CSV_ATTACHMENT_NOTE_TEXT,
  ].join("\n\n");

  const csvFilename = `bus_alerts_${dateStampFromScrapedAt(options.scrapedAt)}.csv`;
  const csvString = normalizedAlertsToCsvString(options.alerts);

  console.log(`Sending Kavim email with ${options.alerts.length} alerts`);

  await transporter.sendMail({
    from: fromAddress || from,
    to,
    replyTo: fromAddress,
    subject: KAVIM_EMAIL_SUBJECT,
    text,
    html,
    headers: {
      "List-Unsubscribe": listUnsub,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    attachments: [
      {
        filename: csvFilename,
        content: csvString,
        contentType: "text/csv; charset=utf-8",
      },
    ],
  });

  return { sent: true, to };
}
