# Israel Scraper (Local Mac Setup)

Local-first setup for running the scraper and dashboard on macOS.

## Prerequisites

- Node.js 20+ (recommended: current LTS)
- `pnpm` installed globally
- Google Chrome installed (default path on macOS is supported)

## 1) Install dependencies

```bash
cd "/Users/avi/Scraper_Israel_Backup"
pnpm install
```

## 2) Configure local environment

```bash
cp .env.example .env
```

You can put secrets in **either** the repo root `.env` **or** `b_UUco9SpqaeI/.env.local` (Next loads both).

Edit and set what you need:

- `GROQ_API_KEY` (optional, for AI summaries + on-demand translation in the UI)
- `GROQ_MODEL` (optional; default is `llama-3.1-8b-instant` in code)
- `PUPPETEER_EXECUTABLE_PATH` (optional; defaults to macOS Chrome path)
- `BUS_ALERTS_EMAIL_*` (optional; required only for email sending)

**Packaged app (`Israel Scraper.app`):** put the same `KEY=value` lines in:

`~/Library/Application Support/Israel Scraper/config.env`

The Electron shell reads that file so Groq/translation work in the installed app (not only `pnpm dev`).

Example for explicit local Chrome:

```env
PUPPETEER_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

## 3) Bus Nearby — מדיניות (רק `busnearby`; לא משפיע על דן / אגד / קווים / מטרופולין)

ההתנהגות הבאה חלה **רק** על סקרייפר Bus Nearby (`--agency=busnearby` או כשב־`--all` מגיע התור אליו):

| מה אתה מריץ | מה קורה |
|---------------|---------|
| **בלי `--refresh`**, אבל **למאגר כבר יש** מסלולים ב־`routes-database.json` | **אין** גילוי מחדש מעמודי `searchRoute`. הסקרייפר עובד **רק** על כתובות המסלולים שכבר נשמרות — ומעדכן **התראות** לפי `last_scanned_at` (מרווח ברירת מחדל: 24 שעות לכל קו; `BUSNEARBY_SCAN_STALE_AFTER_H`). זה **לא** “סריקת עומק”: לא מוחקים לינקים ולא מחייבים `--refresh`. |
| **מאגר ריק** (פעם ראשונה / אחרי מחיקה) | גילוי מסלולים רץ **אוטומטית** (כמו `--refresh`), נשמר ב־`routes-database.json`, ואז נמשך לסריקת התראות. |
| **עם `--refresh`** (או `pnpm run init-routes`) | “סריקת עומק”: עובר שוב על עמודי חיפוש לפי `agencyFilter`, **ממזג** לינקים חדשים למאגר (לא מחליף את הקובץ בכללותו), ואז סורק. |
| **סוכן `agencyFilter` בלי אף לינק בעמוד** | נרשם ב־`data/busnearby-agency-exclusions.json` ו־**לא** ייכלל בעתיד בגילוי (`--refresh`) עד שתשחזר ידנית. |

### First-time routes initialization (Bus Nearby)

אם `routes-database.json` **ריק**, הרצה רגילה של `busnearby` **תפעיל גילוי אוטומטית** (לא צריך לזכור `init-routes`). אם רוצים **בעצמך** להריץ גילוי מחדש:

```bash
pnpm run init-routes
```

אחרי שיש מסלולים, סריקות רגילות **לא** מוחקות את המאגר — רק מעדכנות התראות על מסלולים קיימים לפי רמת “רענון” (ברירת מחדל 24 שעות לקו). **סריקת עומק** (`--refresh`) רק כשאתה בוחר להוסיף לינקים מעמודי `searchRoute`.

סוכנים (agencyFilter) שקיבלו **אפס לינקים** ברענון נשמרים ב־`data/busnearby-agency-exclusions.json` ומדולגים ב־`--refresh` הבאים עד שתשחזר:

```bash
pnpm run restore-busnearby-agencies
```

ואז שוב `pnpm run init-routes` אם רוצים לנסות שוב לגלות מהעמודים האלה.

## 4) Run a local scan

Run all agencies:

```bash
pnpm run scan -- --all
```

Run a single agency (fast scan — uses existing routes DB for Bus Nearby):

```bash
pnpm run scan -- --agency=busnearby
pnpm run scan -- --agency=egged
```

Re-discover Bus Nearby route links (heavy):

```bash
pnpm run scan -- --agency=busnearby --refresh
```

## 5) Run dashboard on localhost

```bash
pnpm --dir b_UUco9SpqaeI run dev
```

Open: `http://localhost:3000`

## Common commands

- Build dashboard: `pnpm run build:dashboard`
- Typecheck workspace: `pnpm run typecheck`
- Install Puppeteer-managed Chrome (optional): `pnpm run install:chrome`

## Notes

- This setup is local only (no Docker/Cloud Run/GitHub Actions required).
- Scraper data is written under `data/` in the repository root.

### macOS app (`Israel Scraper.app`) — אורקסטרטור בלי `tsx`

הבילד של הדסקטופ (`pnpm run desktop:prepare`) יוצר `resources/scraper/dist/orchestrator.mjs` (ESM, `esbuild`) כדי **לא** להריץ `tsx` בתוך ה־`.app` — אחרת לעיתים חסר `@esbuild/darwin-*` והסריקה נופלת עם `TransformError`. אחרי עדכון קוד, בנה מחדש DMG:

```bash
pnpm run desktop:build
```

זה **לא** קשור ל־Bus Nearby או ללינקים; זה תלות אריזה של Node.
