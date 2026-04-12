import { RateLimitError } from "groq-sdk"

import type { TransportAlert } from "@/lib/transport-alert"
import { sanitizeAiSummaryOutput } from "@/lib/ai-summary-sanitize"
import {
  extractStructuredFromTransportAlert,
  type StructuredAlertForAi,
} from "@/lib/server/alert-structured-extract"
import { generateDispatcherSummaryHebrew } from "@/lib/server/groq-alert-summary"

import {
  eggedSummaryCacheKey,
  eggedSummaryLookupKeys,
  isEggedPipelineAlert,
} from "@/lib/egged-ai-summary-id"

import { readAiSummariesCache, writeAiSummariesCache } from "./ai-summaries-cache"

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms))

function isTooManyRequests(e: unknown): boolean {
  if (e instanceof RateLimitError) return true
  const msg = e instanceof Error ? e.message : String(e)
  if (/429|Too Many Requests|rate limit|RESOURCE_EXHAUSTED/i.test(msg)) {
    return true
  }
  const any = e as { status?: number; response?: { status?: number } }
  return any?.status === 429 || any?.response?.status === 429
}

export function buildStructuredMapForAlerts(
  alerts: TransportAlert[]
): Map<string, StructuredAlertForAi> {
  const m = new Map<string, StructuredAlertForAi>()
  for (const a of alerts) {
    m.set(a.id, extractStructuredFromTransportAlert(a))
  }
  return m
}

export type AttachAiSummariesOptions = {
  /**
   * כש-false (ברירת מחדל): רק קריאה מ־data/ai-summaries.json — בלי קריאות Groq.
   * true: יוצר סיכום חסר דרך Groq (מייל / זרימות מפורשות).
   */
  generateMissing?: boolean
  /**
   * אגד בלבד: אם אין פגיעה במטמון (כולל מפתחות legacy), מייצר סיכום ב־Groq.
   * דורש apiKey; שימושי לדשבורד אחרי שינוי פורמט מזהים.
   */
  generateEggedMissing?: boolean
  /**
   * מקסימום קריאות Groq לבקשה אחת (דשבורד). 0 = ללא גבול (למשל שליחת מייל).
   * ברירת מחדל: מ־GROQ_MAX_SUMMARIES_PER_REQUEST או 12.
   */
  maxGeneratePerRequest?: number
}

/**
 * ממלא aiSummary ממטמון הקובץ; אופציונלית יוצר חסרים ב-Groq.
 * אחרי כל סיכום מוצלח נשמר מיד ל־ai-summaries.json כדי שלא יאבדו בכשל בודד.
 */
function resolveMaxGeneratePerRequest(options?: AttachAiSummariesOptions): number {
  if (options?.maxGeneratePerRequest !== undefined) {
    const n = options.maxGeneratePerRequest
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 12
  }
  const raw = process.env.GROQ_MAX_SUMMARIES_PER_REQUEST?.trim()
  if (raw === "" || raw === undefined) return 12
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 12
}

/** @returns כמה סיכומים נוצרו בפועל בקריאות Groq (לא כולל מטמון / סיכום שכבר היה במיזוג) */
export async function attachAiSummariesToAlerts(
  alerts: TransportAlert[],
  apiKey: string | undefined,
  structuredById?: Map<string, StructuredAlertForAi>,
  options?: AttachAiSummariesOptions
): Promise<number> {
  const generateMissing = options?.generateMissing === true
  const key = apiKey?.trim()
  const maxGen = resolveMaxGeneratePerRequest(options)
  let generated = 0

  const cache = await readAiSummariesCache()

  const cacheKeysForAlert = (a: typeof alerts[0]) =>
    isEggedPipelineAlert(a) ? eggedSummaryLookupKeys(a) : [a.id]

  const writeKeyForAlert = (a: typeof alerts[0]) =>
    isEggedPipelineAlert(a) ? eggedSummaryCacheKey(a) : a.id

  const generateEggedMissing = options?.generateEggedMissing === true

  for (const alert of alerts) {
    let cachedRaw: string | undefined
    for (const k of cacheKeysForAlert(alert)) {
      const v = cache.byId[k]?.trim()
      if (v) {
        cachedRaw = v
        break
      }
    }
    if (cachedRaw) {
      alert.aiSummary = sanitizeAiSummaryOutput(cachedRaw)
      continue
    }

    const fromMerge = sanitizeAiSummaryOutput(alert.aiSummary ?? "").trim()
    if (fromMerge) {
      alert.aiSummary = fromMerge
      continue
    }

    const allowEggedGen =
      generateEggedMissing && isEggedPipelineAlert(alert) && Boolean(key)
    if ((!generateMissing && !allowEggedGen) || !key) {
      continue
    }

    if (maxGen > 0 && generated >= maxGen) {
      continue
    }

    const structured =
      structuredById?.get(alert.id) ??
      extractStructuredFromTransportAlert(alert)

    console.log(
      `[AI] Generating summary for: ${(alert.title ?? "").slice(0, 120)}...`
    )

    try {
      await sleep(1500)
      const { summary, usage } = await generateDispatcherSummaryHebrew(
        key,
        structured
      )
      if (usage) {
        console.log(
          `[AI] Groq tokens (body): prompt=${usage.prompt_tokens}, completion=${usage.completion_tokens}, total=${usage.total_tokens}` +
            (usage.queue_time != null
              ? ` | queue_time=${String(usage.queue_time)}`
              : "")
        )
      }
      if (summary) {
        const clean = sanitizeAiSummaryOutput(summary)
        alert.aiSummary = clean
        const wk = writeKeyForAlert(alert)
        cache.byId[wk] = clean
        await writeAiSummariesCache(cache)
        generated++
      }
    } catch (e) {
      if (isTooManyRequests(e)) {
        console.error("[AI] 429 rate limit:", alert.id, e)
        console.log(
          "Rate limit reached or error occurred. Saving progress and stopping."
        )
        // סיכומים שכבר נכתבו ל־ai-summaries.json נשארים; בטעינת דשבורד/מייל הבאים
        // attachAiSummaries עם generateMissing:false ימלא מקובץ המטמון.
        break
      }
      console.error("[AI] Groq failed (no retry):", alert.id, e)
    }
  }
  return generated
}
