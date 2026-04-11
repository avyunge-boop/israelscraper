import { execSync } from "child_process";
import { existsSync } from "fs";
import puppeteer, { type LaunchOptions } from "puppeteer";

const MACOS_CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Headless/server-safe Chromium flags (no `--single-process`; deprecated). */
export const DEFAULT_PUPPETEER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-first-run",
  "--no-zygote",
] as const;

/** Cloud Run sets `K_SERVICE`; Docker often has `/.dockerenv`. */
export function isContainerRuntime(): boolean {
  return Boolean(process.env.K_SERVICE) || existsSync("/.dockerenv");
}

/**
 * Args for `puppeteer.launch({ args })`.
 * - Bundled Chromium: full server defaults.
 * - System Chrome/Chromium in a container (e.g. Cloud Run with `PUPPETEER_EXECUTABLE_PATH`): same defaults.
 * - Local desktop Chrome path: minimal flags (avoid unnecessary sandbox disable).
 */
export function getPuppeteerLaunchArgs(chromePath: string | undefined): string[] {
  if (!chromePath) {
    return [...DEFAULT_PUPPETEER_ARGS];
  }
  if (isContainerRuntime()) {
    return [...DEFAULT_PUPPETEER_ARGS];
  }
  return ["--disable-dev-shm-usage"];
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
