/**
 * סיכום + תרגום לאנגלית לכל התראת Bus Nearby לפני כתיבה ל-scan-export (אותו מודל כמו הדשבורד).
 */
import Groq from "groq-sdk";

import type { NormalizedAlert } from "./scrapers/types";
import { loadRootEnv } from "./repo-paths";

const MODEL = "llama-3.1-8b-instant";

const DISPATCHER_SYSTEM = `Role: Professional Transport Dispatcher & Hebrew Editor.
Task: Create a single-sentence public transport alert in Hebrew from the raw text.
Format: One continuous sentence. No periods. No line breaks. No colons except inside times (e.g. 22:00).
Start with "עקב" when describing a reason. Be formal and concise.
Return ONLY the Hebrew sentence.`;

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
