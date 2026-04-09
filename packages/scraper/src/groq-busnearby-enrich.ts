/**
 * סיכום + תרגום לאנגלית לכל התראת Bus Nearby לפני כתיבה ל-scan-export (אותו מודל כמו הדשבורד).
 */
import Groq from "groq-sdk";

import type { NormalizedAlert } from "./scrapers/types";
import { loadRootEnv } from "./repo-paths";

const MODEL = "llama-3.1-8b-instant";

const DISPATCHER_SYSTEM = `אתה עוזר מקצועי לכתיבת הודעות שינוי מסלולי תחבורה ציבורית בעברית, במבנה קבוע, מדויק, זורם ומקצועי ביותר. כתוב תמיד הודעה אחת רציפה במשפט אחד בלבד (ללא שורות חדשות, ללא נקודותיים מיותרות וללא חזרות). כללים מחייבים: 1. פתח תמיד במילה "עקב" ומיד אחריה את סיבת ההפרעה. מיד לאחר הסיבה ציין את שם הרחוב והעיר בפורמט: ברחוב [שם הרחוב המלא] ב[שם העיר המלא], (פסיק אחרי שם העיר). אם שם העיר לא מופיע - אל תזכיר עיר כלל. 2. מיד אחרי הפסיק: אם יש 3 קווים או פחות: "קיים שינוי במסלול הקווים [מספר], [מספר] ו-[מספר]". אם יש 4 קווים או יותר: "קיים שינוי במסלול קווים נבחרים". אם השינוי לכיוון אחד בלבד - הוסף "לכיוון [צפון/דרום/מזרח/מערב]". 3. לעולם אל תציין רחובות חלופיים או תחנות חלופיות. 4. חבר פרטי תאריך ושעה: אם חוזר מדי לילה/יום - פתח ב"מדי לילה" או "מדי יום". תאריכים: "[יום בשבוע מלא], [מספר] [שם חודש מלא]". אם ההפרעה כבר התחילה - כתוב רק "עד [יום בשבוע], [מספר] [חודש]". שעות: "בין השעות [שעה] ועד [שעה]". 5. משפט אחד רציף וזורם בלבד, ללא נקודה באמצע. דוגמה לפלט: עקב עבודות תשתית ברחוב יפו בירושלים, קיים שינוי במסלול קווים נבחרים עד יום שישי, 11 באפריל בין השעות 22:00 ועד 05:00`;

const TRANSLATE_SYSTEM =
  "Translate the following Hebrew transport alert to clear English. Output only the translation, no quotes.";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

/**
 * מעשיר כל התראה ב-meta.dispatcherSummaryHe ו-meta.summaryEn (ו-meta.fullDescription לתצוגה).
 */
export async function enrichBusnearbyAlertsWithGroq(
  alerts: NormalizedAlert[]
): Promise<NormalizedAlert[]> {
  loadRootEnv();
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key || alerts.length === 0) return alerts;

  const out: NormalizedAlert[] = [];
  for (let i = 0; i < alerts.length; i++) {
    const a = alerts[i]!;
    const raw = `${a.title}\n\n${a.content}`.trim();
    try {
      const he = await groqText(key, DISPATCHER_SYSTEM, `Raw alert:\n${raw}`);
      await sleep(400);
      const en = he
        ? await groqText(key, TRANSLATE_SYSTEM, he)
        : "";
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
      console.error(`[groq-busnearby] alert ${i + 1}/${alerts.length}:`, e);
      out.push(a);
    }
    await sleep(200);
  }
  return out;
}
