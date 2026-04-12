export type DashboardLang = "he" | "en"

export type DashboardUiStrings = {
  title: string
  lastUpdated: string
  globalSync: string
  searchPlaceholder: string
  langSwitch: string
  statsTotalAlerts: string
  statsNewToday: string
  statsDupBlocked: string
  statsSystemStatus: string
  statsOnline: string
  statsOffline: string
  manualActions: string
  automationSettings: string
  sendEmailReportLabel: string
  save: string
  saved: string
  saveFailed: string
  autoScanEvery: string
  selectFrequency: string
  exportCsvPrefix: string
  scanNow: string
  scanAll: string
  initRoutesDb: string
  initRoutesDbHint: string
  initRoutesDbRunning: string
  scanningAll: string
  scanningInProgress: string
  tabAll: string
  loading: string
  loadingAlerts: string
  loadErrorPrefix: string
  loadErrorSuffix: string
  emptyTitle: string
  emptyDescription: string
  aiSummaryHeading: string
  copySummary: string
  copied: string
  translate: string
  translating: string
  translateFailed: string
  translationEnglish: string
  noSummaryYet: string
  readMore: string
  readLess: string
  dateStart: string
  dateEnd: string
  linkToSource: string
  newBadge: string
  tabAlerts: string
  tabStats: string
  tabOperations: string
  sectionNewAlerts: string
  sectionExistingAlerts: string
  logConsoleTitle: string
  logConsoleEmpty: string
  statsLoadError: string
  statsLoading: string
  statsThisWeek: string
  statsThisMonth: string
  statsTopAgency: string
  statsByAgency: string
  statsAlerts: string
  statsVsPrevWeek: string
  statsVsPrevMonth: string
  healthGood: string
  healthBad: string
  healthIssues: string
  healthWarningsShort: string
  healthWarningsHint: string
  scanProgressLabel: string
  routesDbMissingTitle: string
  routesDbMissingDescription: string
  routesDbOpenOperations: string
  routesDbOpenAlertsControls: string
}

const HE: DashboardUiStrings = {
  title: "דשבורד תחבורה",
  lastUpdated: "עדכון אחרון:",
  globalSync: "סנכרון גלובלי: 05/04/2026 12:00",
  searchPlaceholder: "חיפוש לפי קו, עיר או כותרת...",
  langSwitch: "English",
  statsTotalAlerts: "סה״כ התראות",
  statsNewToday: "חדשות היום",
  statsDupBlocked: "כפולים נחסמו",
  statsSystemStatus: "סטטוס מערכת",
  statsOnline: "מחובר",
  statsOffline: "מנותק",
  manualActions: "פעולות ידניות",
  automationSettings: "אוטומציה והגדרות",
  sendEmailReportLabel: "אימייל נמען לדוחות (שליחה אחרי סריקה)",
  save: "שמור",
  saved: "נשמר ב־data/settings.json (שורש הפרויקט)",
  saveFailed: "שמירה נכשלה",
  autoScanEvery: "סריקה אוטומטית כל:",
  selectFrequency: "בחר תדירות",
  exportCsvPrefix: "הורד CSV —",
  scanNow: "סרוק עכשיו",
  scanAll: "סרוק את כל הסוכנויות",
  initRoutesDb: "אתחול מסד מסלולים (Bus Nearby)",
  initRoutesDbHint: "מילוי ראשון של data/routes-database.json — גילוי מסלולים (כמו ‎--refresh‎)",
  initRoutesDbRunning: "מאתחל מסד מסלולים…",
  scanningAll: "סורק את כל הסוכנויות...",
  scanningInProgress: "סורק…",
  tabAll: "הכל",
  loading: "טוען…",
  loadingAlerts: "טוען התראות מקובצי הנתונים…",
  loadErrorPrefix: "לא ניתן לטעון נתונים מהשרת:",
  loadErrorSuffix:
    "ודא שקיימים קבצי JSON בתיקיית data/ או בנתיבי הגיבוי (שורש הפרויקט / scripts/).",
  emptyTitle: "לא נמצאו התראות",
  emptyDescription:
    "אין התראות התואמות לחיפוש או לסינון שבחרת. נסה לשנות את הסינון או לחפש משהו אחר.",
  aiSummaryHeading: "סיכום AI",
  copySummary: "העתק סיכום",
  copied: "הועתק",
  translate: "תרגם",
  translating: "מתרגם…",
  translateFailed: "התרגום נכשל",
  translationEnglish: "אנגלית",
  noSummaryYet:
    "אין סיכום עדיין — רענן את הדף (נוצרים סיכומים בקבוצות) או שלח דוח למייל.",
  readMore: "קרא עוד",
  readLess: "הצג פחות",
  dateStart: "תאריך התחלה:",
  dateEnd: "תאריך סיום:",
  linkToSource: "קישור ישיר למקור",
  newBadge: "חדש",
  tabAlerts: "התראות",
  tabStats: "סטטיסטיקה",
  tabOperations: "מבצעי",
  sectionNewAlerts: "התראות חדשות (היום)",
  sectionExistingAlerts: "התראות קיימות",
  logConsoleTitle: "יומן סריקה (זרימה חיה)",
  logConsoleEmpty: "הפעל סריקה כדי לראות פלט…",
  statsLoadError: "שגיאת טעינת סטטיסטיקה",
  statsLoading: "טוען סטטיסטיקה…",
  statsThisWeek: "אירועים השבוע",
  statsThisMonth: "אירועים החודש",
  statsTopAgency: "סוכנות עם הכי הרבה התראות (בסריקה אחרונה)",
  statsByAgency: "לפי סוכנות",
  statsAlerts: "התראות",
  statsVsPrevWeek: "מול שבוע קודם:",
  statsVsPrevMonth: "מול חודש קודם:",
  healthGood: "מערכת תקינה",
  healthBad: "בעיה במערכת",
  healthIssues: "לחץ לפרטים",
  healthWarningsShort: "תקין — יש אזהרות",
  healthWarningsHint: "המערכת עובדת; יש הודעות אזהרה (למשל קובץ export חסר)",
  scanProgressLabel: "התקדמות",
  routesDbMissingTitle: "מסד מסלולים חסר או ריק",
  routesDbMissingDescription:
    "קובץ data/routes-database.json נדרש ל־Bus Nearby. אתחל מסלולים מהכרטיסייה התראות, או עבור למבצעי כדי לראות יומן סריקה אחרי רענון.",
  routesDbOpenOperations: "מעבר למבצעי (יומן)",
  routesDbOpenAlertsControls: "מעבר להתראות (אתחול מסד)",
}

const EN: DashboardUiStrings = {
  title: "Transport Dashboard",
  lastUpdated: "Last updated:",
  globalSync: "Global sync: 05/04/2026 12:00",
  searchPlaceholder: "Search by line, city, or title…",
  langSwitch: "עברית",
  statsTotalAlerts: "Total alerts",
  statsNewToday: "New today",
  statsDupBlocked: "Duplicates blocked",
  statsSystemStatus: "System status",
  statsOnline: "Online",
  statsOffline: "Offline",
  manualActions: "Manual actions",
  automationSettings: "Automation & settings",
  sendEmailReportLabel: "Send Email Report — recipient (sent after scan)",
  save: "Save",
  saved: "Saved to repo root data/settings.json",
  saveFailed: "Save failed",
  autoScanEvery: "Auto-scan every:",
  selectFrequency: "Select interval",
  exportCsvPrefix: "Download CSV —",
  scanNow: "Scan Now",
  scanAll: "Scan Now",
  initRoutesDb: "Initialize routes DB (Bus Nearby)",
  initRoutesDbHint:
    "First-time fill of data/routes-database.json — route discovery (same as --refresh)",
  initRoutesDbRunning: "Initializing routes database…",
  scanningAll: "Scanning all agencies…",
  scanningInProgress: "Scanning…",
  tabAll: "All",
  loading: "Loading…",
  loadingAlerts: "Loading alerts from data files…",
  loadErrorPrefix: "Could not load data from server:",
  loadErrorSuffix:
    "Ensure JSON files exist in data/ or backup paths (project root / scripts/).",
  emptyTitle: "No alerts found",
  emptyDescription:
    "No alerts match your search or filter. Try changing the filter or search.",
  aiSummaryHeading: "AI summary",
  copySummary: "Copy Summary",
  copied: "Copied!",
  translate: "Translate",
  translating: "Translating…",
  translateFailed: "Translation failed",
  translationEnglish: "English",
  noSummaryYet:
    "No summary yet — refresh the page (batch limit) or send an email report to generate more.",
  readMore: "Read more",
  readLess: "Show less",
  dateStart: "Start:",
  dateEnd: "End:",
  linkToSource: "Open source link",
  newBadge: "New",
  tabAlerts: "Alerts",
  tabStats: "Statistics",
  tabOperations: "Operations",
  sectionNewAlerts: "New alerts (today)",
  sectionExistingAlerts: "Existing alerts",
  logConsoleTitle: "Scan log (live stream)",
  logConsoleEmpty: "Run a scan to see output…",
  statsLoadError: "Failed to load statistics",
  statsLoading: "Loading statistics…",
  statsThisWeek: "Incidents this week",
  statsThisMonth: "Incidents this month",
  statsTopAgency: "Agency with most alerts (latest export)",
  statsByAgency: "By agency",
  statsAlerts: "alerts",
  statsVsPrevWeek: "vs previous week:",
  statsVsPrevMonth: "vs previous month:",
  healthGood: "System healthy",
  healthBad: "System issue",
  healthIssues: "Click for details",
  healthWarningsShort: "OK — warnings",
  healthWarningsHint: "System is up; see warnings (e.g. missing scan export)",
  scanProgressLabel: "Progress",
  routesDbMissingTitle: "Routes database missing or empty",
  routesDbMissingDescription:
    "data/routes-database.json is required for Bus Nearby. Initialize routes from the Alerts tab, or open Operations to watch the live scan log after a refresh.",
  routesDbOpenOperations: "Open Operations (log)",
  routesDbOpenAlertsControls: "Open Alerts (initialize DB)",
}

export function getDashboardUiStrings(lang: DashboardLang): DashboardUiStrings {
  return lang === "en" ? EN : HE
}

export function parseDashboardLang(param: string | null): DashboardLang {
  return param === "en" ? "en" : "he"
}

export type IntervalOption = { value: string; label: string }

export function getDashboardIntervals(lang: DashboardLang): IntervalOption[] {
  if (lang === "en") {
    return [
      { value: "1", label: "1 hour" },
      { value: "2", label: "2 hours" },
      { value: "4", label: "4 hours" },
      { value: "6", label: "6 hours" },
      { value: "12", label: "12 hours" },
      { value: "24", label: "24 hours" },
    ]
  }
  return [
    { value: "1", label: "שעה אחת" },
    { value: "2", label: "שעתיים" },
    { value: "4", label: "4 שעות" },
    { value: "6", label: "6 שעות" },
    { value: "12", label: "12 שעות" },
    { value: "24", label: "24 שעות" },
  ]
}

export function getDashboardUiBundle(lang: DashboardLang) {
  return {
    ui: getDashboardUiStrings(lang),
    intervals: getDashboardIntervals(lang),
  }
}

export function filterTabLabel(
  lang: DashboardLang,
  filter: string
): string {
  if (filter === "all") {
    return lang === "en" ? "All" : "הכל"
  }
  if (filter === "busnearby") return "Bus Nearby"
  return filter
}

/** Bus Nearby מעדכן בעיקר routes-database — לא scan-export; בלי הודעת "0 התראות". */
export function busnearbyScanRoutesOnlyMessage(lang: DashboardLang): string {
  if (lang === "en") {
    return "Bus Nearby scan finished. Routes data was updated (routes-database.json)."
  }
  return "סריקת Bus Nearby הושלמה. נתוני מסלולים עודכנו (routes-database.json)."
}

export function scanCompleteMessage(
  lang: DashboardLang,
  n: number,
  scope: string,
  opts?: { emailSkipped?: boolean; emailSkipReason?: string }
): string {
  if (opts?.emailSkipped) {
    if (opts.emailSkipReason === "smtp_not_configured") {
      if (lang === "en") {
        return `Done: scan completed. Filter: ${scope}.`
      }
      return `הסתיים: הסריקה הושלמה. מסנן: ${scope}.`
    }
    if (opts.emailSkipReason === "no_alerts_for_filter") {
      if (lang === "en") {
        return `Done: scan completed. No alerts to email for this filter (${scope}).`
      }
      return `הסתיים: הסריקה הושלמה. אין התראות לשליחה במסנן (${scope}).`
    }
    if (lang === "en") {
      return `Done: scan completed. No email — set BUS_ALERTS_SMTP_HOST and BUS_ALERTS_EMAIL_FROM to send reports. Filter: ${scope}.`
    }
    return `הסתיים: הסריקה הושלמה. מייל לא נשלח — הגדר BUS_ALERTS_SMTP_HOST ו-BUS_ALERTS_EMAIL_FROM (למשל ב-.env או Cloud Run). מסנן: ${scope}.`
  }
  if (lang === "en") {
    return `Done: email report sent with ${n} alert(s) (filter: ${scope}).`
  }
  return `הסתיים: נשלח מייל עם ${n} התראות (מסנן: ${scope})`
}

export function scanAllCompleteMessage(
  lang: DashboardLang,
  n: number,
  opts?: { emailSkipped?: boolean; emailSkipReason?: string }
): string {
  if (opts?.emailSkipped) {
    if (opts.emailSkipReason === "smtp_not_configured") {
      if (lang === "en") {
        return `Scan completed (all operators).`
      }
      return `הסריקה הושלמה (כל המפעילים).`
    }
    if (opts.emailSkipReason === "no_alerts_for_filter") {
      if (lang === "en") {
        return `Scan completed. No alerts to email for this filter (all operators).`
      }
      return `הסריקה הושלמה. אין התראות לשליחה במסנן (כל המפעילים).`
    }
    if (lang === "en") {
      return `Scan completed. No email — configure SMTP env vars to send reports (all operators).`
    }
    return `הסריקה הושלמה. מייל לא נשלח — להגדרת דוח במייל יש להגדיר משתני SMTP (כל המפעילים).`
  }
  if (lang === "en") {
    return `Email report sent with ${n} alert(s) (all operators).`
  }
  return `נשלח מייל עם ${n} התראות (כל המפעילים)`
}

export function scanOrEmailError(lang: DashboardLang): string {
  return lang === "en" ? "Scan or email error" : "שגיאת סריקה או מייל"
}
