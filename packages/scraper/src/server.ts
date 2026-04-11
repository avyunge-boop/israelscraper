/**
 * HTTP API for Cloud Run: POST /run-scrape starts the orchestrator in the background (returns immediately;
 * use GET /status and GET /last-result to track completion — avoids HTTP request timeouts on long runs).
 * Set SCRAPER_STORAGE=gcs and GCS_BUCKET_NAME (default israelscraper) to upload data/*.json after a successful run.
 *
 * Email: by default SCRAPER_ORCHESTRATOR_SKIP_ALL_EMAIL=1 (no emails from orchestrator/scrapers).
 * On Cloud Run, set SCRAPER_ORCHESTRATOR_SKIP_ALL_EMAIL=0 and BUS_ALERTS_SMTP_* + BUS_ALERTS_EMAIL_* to send reports.
 */
import { spawn } from "child_process";
import express from "express";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  readDataArtifactFromGcs,
  uploadDataArtifactsToGcs,
} from "./gcs-sync.js";
import { DATA_DIR, loadRootEnv, REPO_ROOT } from "./repo-paths.js";

loadRootEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRAPER_PKG_ROOT = path.resolve(__dirname, "..");

function isMonorepoWorkspace(): boolean {
  return existsSync(path.join(REPO_ROOT, "pnpm-workspace.yaml"));
}

type RunScrapeBody = {
  agency?: string;
  all?: boolean;
  refresh?: boolean;
};

/** Orchestrator prints JSON summaries per agent; at least one `"ok": true` means partial success. */
function orchestratorHadAnySuccessfulAgent(stdout: string): boolean {
  return /"ok"\s*:\s*true/.test(stdout);
}

function buildOrchestratorArgv(body: RunScrapeBody): string[] {
  const argv: string[] = [];
  if (body?.all === true) {
    argv.push("--all");
  } else if (typeof body?.agency === "string" && body.agency.trim()) {
    argv.push(`--agency=${body.agency.trim()}`);
  } else {
    argv.push("--all");
  }
  if (body?.refresh === true) {
    argv.push("--refresh");
  }
  return argv;
}

/** Label for /status and POST responses (human-readable scope). */
function scrapeLabel(body: RunScrapeBody): string {
  if (body?.all === true) {
    return body?.refresh === true ? "all (refresh)" : "all";
  }
  if (typeof body?.agency === "string" && body.agency.trim()) {
    const a = body.agency.trim();
    return body?.refresh === true ? `${a} (refresh)` : a;
  }
  return body?.refresh === true ? "all (refresh)" : "all";
}

type LastScrapeResult = {
  exitCode: number;
  gcsUploaded: string[];
  stdout: string;
  stderr: string;
  completedAt: string;
  gcsError?: string;
};

const scrapeJob = {
  running: false,
  agency: "",
  startedAt: null as string | null,
};

let lastScrapeResult: LastScrapeResult | null = null;

function runOrchestrator(argv: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  /** ברירת מחדל: בלי מייל (כמו proxy מקומי). אם מגדירים SCRAPER_ORCHESTRATOR_SKIP_ALL_EMAIL ב-Cloud Run — לא דורסים. */
  const env = {
    ...process.env,
    ...(process.env.SCRAPER_ORCHESTRATOR_SKIP_ALL_EMAIL === undefined
      ? { SCRAPER_ORCHESTRATOR_SKIP_ALL_EMAIL: "1" }
      : {}),
  };

  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];

    const shell = process.platform === "win32";
    let child;

    if (isMonorepoWorkspace()) {
      const pnpmArgs = [
        "--filter",
        "@workspace/scraper",
        "run",
        "scan",
        "--",
        ...argv,
      ];
      console.log(
        `[server] spawn monorepo: pnpm ${pnpmArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")} cwd=${REPO_ROOT}`
      );
      child = spawn("pnpm", pnpmArgs, { cwd: REPO_ROOT, env, shell });
    } else {
      const tsxCli = path.join(
        SCRAPER_PKG_ROOT,
        "node_modules",
        "tsx",
        "dist",
        "cli.mjs"
      );
      const orch = path.join(SCRAPER_PKG_ROOT, "src", "orchestrator.ts");
      console.log(
        `[server] spawn standalone: node tsx ${orch} ${argv.join(" ")} cwd=${SCRAPER_PKG_ROOT}`
      );
      child = spawn(
        process.execPath,
        [tsxCli, orch, ...argv],
        { cwd: SCRAPER_PKG_ROOT, env }
      );
    }

    child.stdout?.on("data", (c: Buffer) => out.push(Buffer.from(c)));
    child.stderr?.on("data", (c: Buffer) => err.push(Buffer.from(c)));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8"),
      });
    });
  });
}

const DATA_FILE_NAMES = new Set([
  "bus-alerts.json",
  "scan-export.json",
  "routes-database.json",
  "egged-alerts.json",
  "ai-summaries.json",
  "settings.json",
  "alert-activity.json",
  "agencies-registry.json",
  "busnearby-agency-exclusions.json",
]);

/** כשאין קובץ ב-GCS ובדיסק — מחזירים JSON תקין כדי שהדשבורד לא יקבל 404 (אין קבצים אלה בקונטיינר). */
const EMPTY_JSON_STUBS: Record<string, string> = {
  "ai-summaries.json": '{"byId":{}}',
  "settings.json": "{}",
  "alert-activity.json": '{"byId":{}}',
};

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, service: "israel-scraper" });
});

app.get("/status", (_req, res) => {
  res.status(200).json({
    running: scrapeJob.running,
    agency: scrapeJob.running ? scrapeJob.agency : "",
    startedAt: scrapeJob.startedAt ?? "",
  });
});

app.get("/last-result", (_req, res) => {
  if (lastScrapeResult === null) {
    return res.status(404).json({ error: "no completed scrape yet" });
  }
  return res.status(200).json(lastScrapeResult);
});

/** קריאת קבצי data/ לדשבורד — עם SCRAPER_STORAGE=gcs קודם מ-GCS (אחרי איפוס קונטיינר אין דיסק). */
app.get("/data/:name", async (req, res) => {
  const name = String(req.params.name ?? "");
  if (!DATA_FILE_NAMES.has(name)) {
    return res.status(404).json({ error: "not found" });
  }
  try {
    if (process.env.SCRAPER_STORAGE === "gcs") {
      const fromGcs = await readDataArtifactFromGcs(name);
      if (fromGcs !== null) {
        return res
          .status(200)
          .type("application/json; charset=utf-8")
          .send(fromGcs);
      }
    }
    const fp = path.join(DATA_DIR, name);
    if (!existsSync(fp)) {
      const stub = EMPTY_JSON_STUBS[name];
      if (stub !== undefined) {
        return res
          .status(200)
          .type("application/json; charset=utf-8")
          .send(stub);
      }
      return res.status(404).json({ error: "not found" });
    }
    const raw = readFileSync(fp, "utf-8");
    return res
      .status(200)
      .type("application/json; charset=utf-8")
      .send(raw);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.post("/run-scrape", (req, res) => {
  const body = (req.body ?? {}) as RunScrapeBody;
  if (scrapeJob.running) {
    return res.status(409).json({
      ok: false,
      error: "scrape already running",
      agency: scrapeJob.agency,
    });
  }
  const argv = buildOrchestratorArgv(body);
  const label = scrapeLabel(body);
  console.log(
    `[server] POST /run-scrape label=${JSON.stringify(label)} argv=${JSON.stringify(argv)} body=${JSON.stringify(body)} monorepo=${isMonorepoWorkspace()} cwd=${REPO_ROOT}`
  );
  scrapeJob.running = true;
  scrapeJob.agency = label;
  scrapeJob.startedAt = new Date().toISOString();

  void (async () => {
    try {
      const { code, stdout, stderr } = await runOrchestrator(argv);
      let uploaded: string[] = [];
      let gcsError: string | undefined;
      const shouldUploadGcs =
        process.env.SCRAPER_STORAGE === "gcs" &&
        (code === 0 || orchestratorHadAnySuccessfulAgent(stdout));
      if (shouldUploadGcs) {
        try {
          uploaded = await uploadDataArtifactsToGcs();
        } catch (e) {
          gcsError = String(e);
        }
      }
      lastScrapeResult = {
        exitCode: code,
        gcsUploaded: uploaded,
        stdout,
        stderr,
        completedAt: new Date().toISOString(),
        ...(gcsError !== undefined ? { gcsError } : {}),
      };
      console.log(
        `[server] scrape finished exit=${code} gcs=${uploaded.length}${gcsError ? ` gcsError=${gcsError}` : ""}`
      );
    } catch (e) {
      const msg = String(e);
      lastScrapeResult = {
        exitCode: 1,
        gcsUploaded: [],
        stdout: "",
        stderr: msg,
        completedAt: new Date().toISOString(),
      };
      console.error(`[server] scrape failed: ${msg}`);
    } finally {
      scrapeJob.running = false;
      scrapeJob.startedAt = null;
      scrapeJob.agency = "";
    }
  })();

  return res.status(200).json({ ok: true, started: true, agency: label });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
