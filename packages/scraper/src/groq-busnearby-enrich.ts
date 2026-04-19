/**
 * סיכום + תרגום לאנגלית לכל התראת Bus Nearby לפני כתיבה ל-scan-export (אותו מודל כמו הדשבורד).
 */
import Groq, { RateLimitError } from "groq-sdk";

import type { NormalizedAlert } from "./scrapers/types";
import { loadRootEnv } from "./repo-paths";

const MODEL = "llama-3.1-8b-instant";

const DISPATCHER_SYSTEM = `אתה עוזר מקצועי לכתיבת הודעות שינוי מסלולי תחבורה ציבורית בעברית, במבנה קבוע, מדויק, זורם ומקצועי ביותר. כתוב תמיד הודעה אחת רציפה במשפט אחד בלבד (ללא שורות חדשות, ללא נקודותיים מיותרות וללא חזרות). כללים מחייבים: 1. פתח תמיד במילה "עקב" ומיד אחריה את סיבת ההפרעה. מיד לאחר הסיבה ציין את שם הרחוב והעיר בפורמט: ברחוב [שם הרחוב המלא] ב[שם העיר המלא], (פסיק אחרי שם העיר). אם שם העיר לא מופיע - אל תזכיר עיר כלל. 2. מיד אחרי הפסיק: אם יש 3 קווים או פחות: "קיים שינוי במסלול הקווים [מספר], [מספר] ו-[מספר]". אם יש 4 קווים או יותר: "קיים שינוי במסלול קווים נבחרים". אם השינוי לכיוון אחד בלבד - הוסף "לכיוון [צפון/דרום/מזרח/מערב]". 3. לעולם אל תציין רחובות חלופיים או תחנות חלופיות. 4. חבר פרטי תאריך ושעה: אם חוזר מדי לילה/יום - פתח ב"מדי לילה" או "מדי יום". תאריכים: "[יום בשבוע מלא], [מספר] [שם חודש מלא]". אם ההפרעה כבר התחילה - כתוב רק "עד [יום בשבוע], [מספר] [חודש]". שעות: "בין השעות [שעה] ועד [שעה]". 5. משפט אחד רציף וזורם בלבד, ללא נקודה באמצע. דוגמה לפלט: עקב עבודות תשתית ברחוב יפו בירושלים, קיים שינוי במסלול קווים נבחרים עד יום שישי, 11 באפריל בין השעות 22:00 ועד 05:00`;

const TRANSLATE_SYSTEM =
  "Translate the following Hebrew transport alert to clear English. Output only the translation, no quotes.";

const DELAY_MS_BETWEEN_GROQ_ALERTS = 2000;
const PER_ALERT_TIMEOUT_MS = 30_000;
const MAX_GROQ_ALERT_CONTENT_CHARS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function logTitleSnippet(title: string, maxLen = 72): string {
  const t = title.replace(/\s+/g, " ").trim();
  if (t.length <= maxLen) return t || "(no title)";
  return `${t.slice(0, maxLen)}…`;
}

function truncateGroqContent(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_GROQ_ALERT_CONTENT_CHARS) return compact;
  return `${compact.slice(0, MAX_GROQ_ALERT_CONTENT_CHARS)}…`;
}

function isGroqRateLimit(e: unknown): boolean {
  if (e instanceof RateLimitError) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /429|Too Many Requests|rate limit/i.test(msg);
}

async function groqText(
  apiKey: string,
  system: string,
  user: string
): Promise<string> {
  const groq = new Groq({ apiKey });
  const model = process.env.GROQ_MODEL?.trim() || MODEL;
  const completion = await groq.chat.completions.create({
    model,
    temperature: 0.25,
    max_tokens: 512,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user.slice(0, 12_000) },
    ],
  });
  return String(completion.choices[0]?.message?.content ?? "").trim();
}

/** Retries transient Groq 429s (common on long busnearby runs). */
async function groqTextWithRetry(
  apiKey: string,
  system: string,
  user: string,
  label: string
): Promise<string> {
  const max = 5;
  for (let attempt = 0; attempt < max; attempt++) {
    try {
      return await groqText(apiKey, system, user);
    } catch (e) {
      if (!isGroqRateLimit(e) || attempt === max - 1) {
        throw e;
      }
      const waitMs = Math.min(4000 * 2 ** attempt, 45_000) + Math.floor(Math.random() * 800);
      console.warn(
        `[groq] ${label}: HTTP 429 / rate limit, retry ${attempt + 1}/${max - 1} in ${waitMs}ms`
      );
      await sleep(waitMs);
    }
  }
  throw new Error("groqTextWithRetry: exhausted retries");
}

/** True when routes-database.json (via dedupe meta) already has full Groq output */
function hasCompleteGroqMeta(a: NormalizedAlert): boolean {
  const he =
    typeof a.meta?.dispatcherSummaryHe === "string"
      ? a.meta.dispatcherSummaryHe.trim()
      : "";
  const en =
    typeof a.meta?.summaryEn === "string" ? a.meta.summaryEn.trim() : "";
  return he.length > 0 && en.length > 0;
}

/**
 * מעשיר התראות ב-meta.dispatcherSummaryHe ו-meta.summaryEn.
 * רצף אחד-אחד, השהייה בין קריאות, timeout לכל התראה, מדלג על כאלה שכבר ב-cache (מ־routes-database).
 */
export async function enrichBusnearbyAlertsWithGroq(
  alerts: NormalizedAlert[]
): Promise<NormalizedAlert[]> {
  loadRootEnv();
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key || alerts.length === 0) return alerts;

  const needGroq = alerts.filter((a) => !hasCompleteGroqMeta(a)).length;
  console.log(
    `[groq] Groq enrich starting for ${alerts.length} alerts (${needGroq} need API, ${alerts.length - needGroq} cached in routes DB)`
  );

  const out: NormalizedAlert[] = [];
  let skipped = 0;
  for (let i = 0; i < alerts.length; i++) {
    const a = alerts[i]!;
    const n = alerts.length;
    const idx = i + 1;

    if (hasCompleteGroqMeta(a)) {
      const he = String(a.meta?.dispatcherSummaryHe ?? "").trim();
      out.push({
        ...a,
        meta: {
          ...a.meta,
          dispatcherSummaryHe: he,
          summaryEn: String(a.meta?.summaryEn ?? "").trim(),
          fullDescription: he || a.content,
        },
      });
      skipped++;
      continue;
    }

    console.log(
      `[groq] enriching alert ${idx}/${n}: ${logTitleSnippet(a.title)}`
    );

    const truncatedContent = truncateGroqContent(String(a.content ?? ""));
    const raw = `${a.title}\n\n${truncatedContent}`.trim();
    try {
      const { he, en } = await withTimeout(
        (async () => {
          const heOut = await groqTextWithRetry(
            key,
            DISPATCHER_SYSTEM,
            `Raw alert:\n${raw}`,
            "dispatcher"
          );
          let enOut = "";
          if (heOut) {
            try {
              enOut = await groqTextWithRetry(
                key,
                TRANSLATE_SYSTEM,
                heOut,
                "translate"
              );
            } catch (e2) {
              console.warn(
                `[groq] alert ${idx}/${n}: Hebrew OK, English translate failed — keeping HE only:`,
                e2 instanceof Error ? e2.message : String(e2)
              );
            }
          }
          return { he: heOut, en: enOut };
        })(),
        PER_ALERT_TIMEOUT_MS,
        "Groq enrich alert"
      );
      out.push({
        ...a,
        meta: {
          ...a.meta,
          dispatcherSummaryHe: he || undefined,
          summaryEn: en || undefined,
          fullDescription: he || a.content,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[groq] alert ${idx}/${n} skipped after error/timeout: ${msg}`
      );
      out.push(a);
    }

    if (idx < n) {
      await sleep(DELAY_MS_BETWEEN_GROQ_ALERTS);
    }
  }
  if (skipped > 0) {
    console.log(
      `[groq] done: used cache for ${skipped}/${alerts.length}; attempted Groq for ${alerts.length - skipped}`
    );
  } else {
    console.log(`[groq] done: processed ${alerts.length} alert(s)`);
  }
  return out;
}
