import { execSync } from "child_process";
import { existsSync } from "fs";

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
  for (const cmd of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try {
      return execSync(`which ${cmd} 2>/dev/null`, { encoding: "utf-8" }).trim() || undefined;
    } catch {
      /* continue */
    }
  }
  return undefined;
}

export function resolveChromeExecutable(): string | undefined {
  const fromEnv =
    process.env.PUPPETEER_EXECUTABLE_PATH?.trim() ||
    process.env.CHROME_PATH?.trim();
  if (fromEnv) return fromEnv;
  if (process.platform === "darwin" && existsSync(MACOS_CHROME)) {
    return MACOS_CHROME;
  }
  return findChromiumExecutable();
}

export const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
