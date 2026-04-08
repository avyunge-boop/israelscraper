/** סוגי מפעילים בתצוגת הדשבורד (כולל ״אחר׳ למקורות Bus Nearby) */
export type AlertProvider = "אגד" | "דן" | "קווים" | "מטרופולין" | "אחר"

/** מקור: קבצי JSON או יצוא orchestrator (scan-export.json) */
export type AlertDataSource = "busnearby" | "egged" | "scan-export"

export interface TransportAlert {
  id: string
  /** לאגד: מזהה תוכן (למשל מ־traffic-updates) — ליישור מפתחות ai-summaries */
  contentId?: string
  title: string
  provider: AlertProvider
  fullContent: string
  lineNumbers: string[]
  link: string
  dateRange: {
    start: string
    end: string
  }
  isNew?: boolean
  /** ISO — למטא-נתונים וסטטיסטיקה */
  sourceScrapedAt?: string
  dataSource: AlertDataSource
  /** סיכום ווטסאפ בעברית (Gemini) */
  aiSummary?: string
  /** תרגום קצר לאנגלית (למשל Bus Nearby אחרי Groq) */
  summaryEn?: string
  /** ISO — מעקב פעילות (מ־data/alert-activity.json) */
  firstSeenAt?: string
  lastSeenAt?: string
  /** מזהה מקור מהאורקסטרטור (busnearby, dan, …) */
  scanSourceId?: string
  /** כותרת קבוצה במייל / תצוגה */
  agencyGroupLabel?: string
}
