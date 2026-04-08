import { execSync } from "child_process";
import { existsSync } from "fs";

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
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--single-process",
] as const;

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

/** אובייקט launch אחיד לכל הסקרייפרים; `extraArgs` מתווספים אחרי ברירת המחדל */
export function buildPuppeteerLaunchOptions(extraArgs: string[] = []): {
  headless: boolean;
  executablePath?: string;
  args: string[];
} {
  const executablePath = resolveChromeExecutable();
  return {
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [...PUPPETEER_LAUNCH_ARGS_DEFAULT, ...extraArgs],
  };
}

export const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
