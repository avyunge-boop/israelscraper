import Groq from "groq-sdk"
import type { CompletionUsage } from "groq-sdk/resources/completions"

import {
  aiSummaryNeedsReformat,
  sanitizeAiSummaryOutput,
} from "@/lib/ai-summary-sanitize"
import type { StructuredAlertForAi } from "@/lib/server/alert-structured-extract"

/** מודל ברירת מחדל — Groq (מודלים ישנים כמו llama3-8b-8192 עלולים להחזיר 400) */
const DEFAULT_MODEL = "llama-3.1-8b-instant"
/** חלופה כבדה (דרך env GROQ_MODEL), למשל llama-3.3-70b-versatile */

const DISPATCHER_SYSTEM_PROMPT = `אתה עוזר מקצועי לכתיבת הודעות שינוי מסלולי תחבורה ציבורית בעברית, במבנה קבוע, מדויק, זורם ומקצועי ביותר. כתוב תמיד הודעה אחת רציפה במשפט אחד בלבד (ללא שורות חדשות, ללא נקודותיים מיותרות וללא חזרות). כללים מחייבים: 1. פתח תמיד במילה "עקב" ומיד אחריה את סיבת ההפרעה. מיד לאחר הסיבה ציין את שם הרחוב והעיר בפורמט: ברחוב [שם הרחוב המלא] ב[שם העיר המלא], (פסיק אחרי שם העיר). אם שם העיר לא מופיע - אל תזכיר עיר כלל. 2. מיד אחרי הפסיק: אם יש 3 קווים או פחות: "קיים שינוי במסלול הקווים [מספר], [מספר] ו-[מספר]". אם יש 4 קווים או יותר: "קיים שינוי במסלול קווים נבחרים". אם השינוי לכיוון אחד בלבד - הוסף "לכיוון [צפון/דרום/מזרח/מערב]". 3. לעולם אל תציין רחובות חלופיים או תחנות חלופיות. 4. חבר פרטי תאריך ושעה: אם חוזר מדי לילה/יום - פתח ב"מדי לילה" או "מדי יום". תאריכים: "[יום בשבוע מלא], [מספר] [שם חודש מלא]". אם ההפרעה כבר התחילה - כתוב רק "עד [יום בשבוע], [מספר] [חודש]". שעות: "בין השעות [שעה] ועד [שעה]". 5. משפט אחד רציף וזורם בלבד, ללא נקודה באמצע. דוגמה לפלט: עקב עבודות תשתית ברחוב יפו בירושלים, קיים שינוי במסלול קווים נבחרים עד יום שישי, 11 באפריל בין השעות 22:00 ועד 05:00`

function buildUserPayload(struct: StructuredAlertForAi): string {
  return `Structured data (JSON). Use with the raw snippet; do not invent streets, cities, or lines that contradict this data:

${JSON.stringify(
  {
    reason: struct.reason,
    street: struct.street,
    city: struct.city,
    lineNumbers: struct.lineNumbers,
    direction: struct.direction,
    formattedSchedule: struct.formattedSchedule,
  },
  null,
  2
)}

Raw sanitized Hebrew text (reference only, max context):
${struct.rawSanitizedSnippet.slice(0, 8000)}

Return ONLY the single Hebrew sentence. No quotation marks around it. No prefix like "Output:" or "סיכום:".`
}

export type DispatcherSummaryResult = {
  summary: string
  /** מגיע מגוף התשובה של Groq (לא מ-headers); אופציונלי */
  usage?: CompletionUsage
}

/** apiKey חייב להגיע מהקורא (למשל process.env.GROQ_API_KEY ב-route) — לא להטמיע מפתח בקוד */
async function generateOnce(
  apiKey: string,
  userText: string
): Promise<{ text: string; usage?: CompletionUsage }> {
  const model =
    process.env.GROQ_MODEL?.trim() || DEFAULT_MODEL
  const groq = new Groq({ apiKey })
  const completion = await groq.chat.completions.create({
    model,
    temperature: 0.25,
    max_tokens: 1024,
    messages: [
      { role: "system", content: DISPATCHER_SYSTEM_PROMPT },
      { role: "user", content: userText },
    ],
  })
  const raw = completion.choices[0]?.message?.content ?? ""
  const text = sanitizeAiSummaryOutput(String(raw).replace(/\r\n/g, "\n").trim())
  return { text, usage: completion.usage }
}

/**
 * משפט עברי בפורמט דיספצ'ר — דרך Groq (קריאה אחת).
 */
export async function generateDispatcherSummaryHebrew(
  apiKey: string,
  structured: StructuredAlertForAi
): Promise<DispatcherSummaryResult> {
  const userText = buildUserPayload(structured)
  const { text: first, usage } = await generateOnce(apiKey, userText)
  let out = first

  if (!out) return { summary: "", usage }

  if (aiSummaryNeedsReformat(out)) {
    out = out.replace(/\./g, "").replace(/\n+/g, " ").trim()
  }

  return { summary: sanitizeAiSummaryOutput(out), usage }
}
