import { execSync } from "child_process";
import { existsSync } from "fs";
import puppeteer, { type LaunchOptions } from "puppeteer";

const MACOS_CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Chromium מהחבילה `chromium` ב-Debian/Ubuntu וב-Docker של Cloud Run */
export const LINUX_SYSTEM_CHROMIUM = "/usr/bin/chromium";

/**
 * ארגומנטי launch לסביבות headless בקונטיינרים (Cloud Run וכו').
 * @see https://pptr.dev/troubleshooting
 */
export const PUPPETEER_LAUNCH_ARGS_DEFAULT = [
  "--no-sandbox",
  /** מפורש לקונטיינרים / Cloud Run — לצד `--no-sandbox` */
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  /**
   * חובה לקונטיינרים: Puppeteer מסמן `pipe: true` רק אם הארגומנט הזה מופיע ב־args.
   * בלי pipe, Node מחכה ל־WebSocket ב־stderr — ועם `dumpio` אותו stream כבר מנותב ל־process.stderr,
   * כך ששורת `DevTools listening` לא מגיעה ל־readline ומתקבל TimeoutError אחרי 30s.
   */
  "--remote-debugging-pipe",
  /**
   * ללא `--single-process`: במצב single-process Chromium על לינוקס/קונטיינר לעיתים לא מדפיס
   * את שורת ה-remote debugging ל-stdout בזמן, ו-Puppeteer נתקע עד timeout.
   */
  "--user-data-dir=/tmp/puppeteer_user_data",
  "--disable-gpu",
  "--font-render-hinting=none",
  "--disable-extensions",
] as const;

function launchArgKey(flag: string): string {
  const eq = flag.indexOf("=");
  return eq === -1 ? flag : flag.slice(0, eq);
}

/** מונע כפילות כשהקריאה מוסיפה ארגומנטים שכבר בברירת המחדל */
function mergeLaunchArgs(
  defaults: readonly string[],
  extra: string[]
): string[] {
  const seen = new Set(defaults.map(launchArgKey));
  const out = [...defaults];
  for (const a of extra) {
    const k = launchArgKey(a);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

export function findChromiumExecutable(): string | undefined {
  for (const cmd of [
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
  ]) {
    try {
      const p =
        execSync(`which ${cmd} 2>/dev/null`, { encoding: "utf-8" }).trim() ||
        undefined;
      if (p) return p;
    } catch {
      /* continue */
    }
  }
  return undefined;
}

/**
 * סדר עדיפות: env → Chromium מערכת בלינוקס → Chrome ב-macOS → which.
 * ב-Cloud Run עם Dockerfile סטנדרטי: בדרך כלל `PUPPETEER_EXECUTABLE_PATH` או `/usr/bin/chromium`.
 */
export function resolveChromeExecutable(): string | undefined {
  const fromEnv =
    process.env.PUPPETEER_EXECUTABLE_PATH?.trim() ||
    process.env.CHROME_PATH?.trim();
  if (fromEnv) return fromEnv;

  if (process.platform === "linux" && existsSync(LINUX_SYSTEM_CHROMIUM)) {
    return LINUX_SYSTEM_CHROMIUM;
  }

  if (process.platform === "darwin" && existsSync(MACOS_CHROME)) {
    return MACOS_CHROME;
  }

  return findChromiumExecutable();
}

function launchTimeoutMs(): number {
  const raw = process.env.PUPPETEER_LAUNCH_TIMEOUT_MS?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 120_000;
}

/** ב-production כבוי כברירת מחדל — dumpio+socket גורם ל-stderr להילכד ול-timeout על WS; PUPPETEER_DUMP_IO=1 לדיבוג */
function shouldDumpIo(): boolean {
  const e = process.env.PUPPETEER_DUMP_IO?.trim().toLowerCase();
  if (e === "1" || e === "true" || e === "yes") return true;
  if (e === "0" || e === "false" || e === "no") return false;
  return process.env.NODE_ENV !== "production";
}

/** אובייקט launch אחיד לכל הסקרייפרים; `extraArgs` מתווספים אחרי ברירת המחדל (ללא כפילות לפי שם דגל) */
export function buildPuppeteerLaunchOptions(extraArgs: string[] = []): {
  headless: boolean;
  executablePath?: string;
  args: string[];
  timeout: number;
  dumpio: boolean;
  /** מחבר דרך pipe במקום לפרסר WebSocket מ-stdout — יציב יותר ב-Docker/Cloud Run */
  pipe: boolean;
} {
  const executablePath = resolveChromeExecutable();
  const dumpio = shouldDumpIo();

  return {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: mergeLaunchArgs(PUPPETEER_LAUNCH_ARGS_DEFAULT, extraArgs),
    timeout: launchTimeoutMs(),
    /**
     * עם `--remote-debugging-pipe` החיבור הוא דרך fd 3/4 — בטוח יחד עם dumpio.
     * ב-production dumpio כבוי אלא אם PUPPETEER_DUMP_IO=1
     */
    dumpio,
    pipe: true,
  };
}

/**
 * בונה אפשרויות, מדפיס אותן ללוג, ממתין שנייה (הכנה לסביבת קונטיינר), ואז מפעיל את דפדפן Puppeteer.
 */
export async function launchPuppeteerBrowser(
  extraArgs: string[] = []
): Promise<Awaited<ReturnType<typeof puppeteer.launch>>> {
  const opts = buildPuppeteerLaunchOptions(extraArgs);
  const hasPipeFlag = opts.args.some((a) => a.startsWith("--remote-debugging-pipe"));
  if (!hasPipeFlag) {
    throw new Error(
      "[puppeteer] missing --remote-debugging-pipe in args (would fall back to WS on stderr and often time out in Docker)"
    );
  }
  console.error(
    "[puppeteer] launch:",
    "pipe flag=" + hasPipeFlag,
    "launch.pipe=" + opts.pipe,
    "timeoutMs=" + opts.timeout,
    "dumpio=" + opts.dumpio,
    "NODE_ENV=" + (process.env.NODE_ENV ?? ""),
    "executable=" + (opts.executablePath ?? "(bundled)")
  );
  console.log("[puppeteer] full launch options:", JSON.stringify(opts, null, 2));
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const launchOptions: LaunchOptions = {
    headless: opts.headless,
    ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
    args: opts.args,
    timeout: opts.timeout,
    dumpio: opts.dumpio,
    pipe: opts.pipe,
  };
  return puppeteer.launch(launchOptions);
}

export const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
