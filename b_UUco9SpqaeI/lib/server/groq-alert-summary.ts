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

const DISPATCHER_SYSTEM_PROMPT = `Role: Professional Transport Dispatcher & Hebrew Editor.
Task: Create a single-sentence public transport alert in Hebrew.
Strict Constraints:

Format: One continuous sentence. No periods anywhere. No line breaks. Do not use colons except inside clock times (e.g. 22:00, 05:00).

Opening: Always start with "עקב" followed by the reason + "ברחוב [Street] ב[City],".

Lines Logic:
- 1-3 lines: "קיים שינוי במסלול הקווים [X], [Y] ו-[Z]"
- 4+ lines: "קיים שינוי במסלול קווים נבחרים"

Add direction ("לכיוון [X]") ONLY if explicitly mentioned.

Exclusions: Never mention alternative routes, stops, or "reverting to normal route".

DateTime: Use full day/month names (יום ראשון, 7 בדצמבר). Use "בין השעות [X] ועד [Y]".

Tone: Formal, concise, and flowy.

Few-Shot Examples for you to follow:

Input: Reason: Infrastructure, Street: Herzl, City: Tel Aviv, Lines: 5, 17, Direction: North, Time: Daily 22:00-05:00, Dec 7-11.
Output: עקב עבודות תשתית ברחוב הרצל בתל אביב, קיים שינוי במסלול הקווים 5 ו-17 לכיוון צפון מדי לילה מיום ראשון, 7 בדצמבר ועד יום חמישי, 11 בדצמבר בין השעות 22:00 ועד 05:00

Input: Reason: Protest, Street: Jaffa, City: Jerusalem, Lines: 1, 2, 3, 4, Time: Monday, Jan 1, 10:00-14:00.
Output: עקב הפגנה ברחוב יפו בירושלים, קיים שינוי במסלול קווים נבחרים ביום שני, 1 בינואר בין השעות 10:00 ועד 14:00`

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
