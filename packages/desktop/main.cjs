/**
 * Electron shell: dev uses `next dev`; packaged macOS loads Next standalone + local JSON data.
 * Packaged mode requires `pnpm run desktop:prepare` first (resources/next + resources/scraper).
 *
 * Debug: ISRAEL_SCRAPER_DEBUG=1 or add --debug after the executable (opens DevTools + ~/Library/.../logs/main.log).
 * Example:
 *   ISRAEL_SCRAPER_DEBUG=1 "/Applications/Israel Scraper.app/Contents/MacOS/Israel Scraper"
 */
const { app, BrowserWindow, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const NEXT_APP_DIR = path.join(REPO_ROOT, "b_UUco9SpqaeI");
const DESKTOP_DIR = path.resolve(__dirname);
const NEXT_LOCAL_RESOURCES_DIR = path.join(DESKTOP_DIR, "resources", "next");
const PORT = 3847;
const HOST = "127.0.0.1";

const debugMode =
  process.env.ISRAEL_SCRAPER_DEBUG === "1" ||
  process.env.ISRAEL_SCRAPER_DEBUG === "true" ||
  process.argv.includes("--debug");

function log(...args) {
  const line = `[Israel Scraper] ${args.map(String).join(" ")}`;
  console.log(line);
  if (app.isPackaged && debugMode) {
    try {
      const logDir = path.join(app.getPath("userData"), "logs");
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(
        path.join(logDir, "main.log"),
        `${new Date().toISOString()} ${line}\n`
      );
    } catch {
      /* ignore log write errors */
    }
  }
}

/** Writable JSON / runtime data — always userData, not inside the read-only .app bundle. */
function userDataDir() {
  const dir = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function macSystemChrome() {
  if (process.platform !== "darwin") return null;
  const p = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return fs.existsSync(p) ? p : null;
}

/**
 * Standalone may be `next/server.js` or `next/<app>/server.js` when
 * outputFileTracingRoot is the monorepo root. cwd must be the directory
 * that contains server.js (Next chdir's there; static lives in ./.next/static).
 */
function findNextServer(root) {
  const direct = path.join(root, "server.js");
  if (fs.existsSync(direct)) {
    return { entry: direct, cwd: root };
  }
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === "node_modules") continue;
    const nested = path.join(root, e.name, "server.js");
    if (fs.existsSync(nested)) {
      return { entry: nested, cwd: path.dirname(nested) };
    }
  }
  return null;
}

function scraperPackagedRoot() {
  return path.join(process.resourcesPath, "scraper");
}

function nextPackagedRoot() {
  return path.join(process.resourcesPath, "next");
}

function isProductionStandaloneMode() {
  return app.isPackaged || process.env.NODE_ENV === "production";
}

let nextChild = null;
let mainWindow = null;

function buildChildEnv(port) {
  const dataDir = userDataDir();
  const resourcesRoot = app.isPackaged ? process.resourcesPath : REPO_ROOT;

  const env = {
    ...process.env,
    PORT: String(port),
    HOSTNAME: HOST,
    NODE_ENV: app.isPackaged ? "production" : process.env.NODE_ENV || "development",
    /** Dashboard + proxy-scan read/write JSON here (writable). */
    SCRAPER_DATA_DIR: dataDir,
    /** Where extraResources live (read-only bundle root). */
    ISRAEL_SCRAPER_RESOURCES: resourcesRoot,
  };

  log(
    `SCRAPER_DATA_DIR=${dataDir} ISRAEL_SCRAPER_RESOURCES=${resourcesRoot} packaged=${app.isPackaged}`
  );

  if (process.platform === "darwin") {
    const chrome = macSystemChrome();
    if (chrome) {
      env.PUPPETEER_EXECUTABLE_PATH = chrome;
    }
  }

  if (app.isPackaged) {
    const sroot = scraperPackagedRoot();
    env.ISRAEL_SCRAPER_PACKAGED_ROOT = sroot;
    env.SCRAPER_REPO_ROOT = sroot;
    const cache = path.join(sroot, "chromium-cache");
    if (fs.existsSync(cache)) {
      env.PUPPETEER_CACHE_DIR = cache;
    }
  }

  return env;
}

/**
 * Wait until something accepts HTTP on host:port (Next responds, even 404).
 */
function waitForServerReady(port, timeoutMs = 120000, intervalMs = 250) {
  const url = `http://${HOST}:${port}/`;
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(
        url,
        { timeout: 2000 },
        (res) => {
          res.resume();
          log(`HTTP ready on ${url} (status ${res.statusCode})`);
          resolve();
        }
      );
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for Next.js on ${url}`
            )
          );
          return;
        }
        setTimeout(tryOnce, intervalMs);
      });
      req.on("timeout", () => {
        req.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timeout waiting for Next.js on ${url}`));
          return;
        }
        setTimeout(tryOnce, intervalMs);
      });
    };
    tryOnce();
  });
}

function startNextServer(port) {
  const env = buildChildEnv(port);

  if (!isProductionStandaloneMode()) {
    nextChild = spawn("pnpm", ["run", "dev", "--", "-p", String(port), "-H", HOST], {
      cwd: NEXT_APP_DIR,
      env,
      shell: true,
      stdio: "inherit",
    });
    attachChildLogging(nextChild);
    return Promise.resolve(nextChild);
  }

  const root = app.isPackaged ? nextPackagedRoot() : NEXT_LOCAL_RESOURCES_DIR;
  const found = findNextServer(root);
  if (!found) {
    return Promise.reject(
      new Error(
        `Next standalone server.js not found under ${root}. Run pnpm run desktop:prepare first.`
      )
    );
  }

  const staticDir = path.join(found.cwd, ".next", "static");
  if (!fs.existsSync(staticDir)) {
    return Promise.reject(
      new Error(
        `Missing static assets at ${staticDir}. Re-run pnpm run desktop:prepare and verify copy paths.`
      )
    );
  }

  log(`Starting Next server: ${found.entry} cwd=${found.cwd}`);
  log(`Static assets dir: ${staticDir}`);

  /**
   * process.execPath is the Electron binary. Without ELECTRON_RUN_AS_NODE, Electron
   * treats the script as a GUI app entry — spawning many instances / windows.
   */
  const nodeEnv = {
    ...env,
    ELECTRON_RUN_AS_NODE: "1",
  };

  nextChild = spawn(process.execPath, [found.entry], {
    cwd: found.cwd,
    env: nodeEnv,
    stdio: debugMode ? "inherit" : "pipe",
  });

  attachChildLogging(nextChild);

  return Promise.resolve(nextChild);
}

function attachChildLogging(child) {
  if (!child || !child.stdout || !child.stderr) return;
  child.stdout.on("data", (buf) => {
    const t = buf.toString("utf8").trimEnd();
    if (t) log(`[next:stdout] ${t}`);
  });
  child.stderr.on("data", (buf) => {
    const t = buf.toString("utf8").trimEnd();
    if (t) log(`[next:stderr] ${t}`);
  });
  child.on("error", (err) => log(`[next] spawn error: ${err}`));
  child.on("exit", (code, signal) => {
    log(`[next] exited code=${code} signal=${signal ?? ""}`);
  });
}

function createWindow(port) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    mainWindow.loadURL(`http://${HOST}:${port}/`);
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  if (debugMode) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
  mainWindow.webContents.on("console-message", (_e, level, message) => {
    if (
      level >= 2 ||
      /failed to load resource| 404 |net::err_/i.test(String(message))
    ) {
      log(`[renderer] ${message}`);
    }
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame) {
        log(`did-fail-load code=${code} desc=${desc} url=${url}`);
      }
    }
  );

  mainWindow.loadURL(`http://${HOST}:${port}/`);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
} else {
  app.on("second-instance", () => {
    log("second-instance: focusing main window");
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  if (debugMode) {
    app.commandLine.appendSwitch("enable-logging");
    log("Debug mode on (DevTools + file log under userData/logs/main.log)");
  }

  if (app.isPackaged && process.platform !== "darwin") {
    await dialog.showErrorBox(
      "Unsupported platform",
      "The packaged DMG build runs on macOS only."
    );
    app.quit();
    return;
  }

  try {
    await startNextServer(PORT);
  } catch (e) {
    log(`startNextServer failed: ${e}`);
    await dialog.showErrorBox("Startup failed", String(e));
    app.quit();
    return;
  }

  try {
    await waitForServerReady(PORT);
  } catch (e) {
    log(`waitForServerReady failed: ${e}`);
    await dialog.showErrorBox("Next.js did not start", String(e));
    if (nextChild && !nextChild.killed) nextChild.kill("SIGTERM");
    app.quit();
    return;
  }

  createWindow(PORT);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(PORT);
    }
  });
});

app.on("window-all-closed", () => {
  if (nextChild && !nextChild.killed) {
    nextChild.kill("SIGTERM");
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (nextChild && !nextChild.killed) {
    nextChild.kill("SIGTERM");
  }
});
