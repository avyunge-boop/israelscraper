/** ניקוי תצוגה/ייצוא — ללא תלות בשרת או ב-Gemini */
export function sanitizeAiSummaryOutput(s: string): string {
  let t = s.replace(/\s+/g, " ").trim()
  t = t.replace(/^["'`׳]+|["'`׳]+$/g, "").trim()
  t = t.replace(/^(סיכום|פלט|output|תשובה)\s*[:：]\s*/i, "").trim()
  t = t.replace(/^\*\*|\*\*$/g, "").trim()
  return t
}

/** נקודה כלשהי או יותר משורה אחת — עובר לתיקון משני (לפי כללי הדיספצ'ר) */
export function aiSummaryNeedsReformat(s: string): boolean {
  const trimmed = s.trim()
  if (/[\r\n]/.test(trimmed)) return true
  if (trimmed.includes(".")) return true
  return false
}
