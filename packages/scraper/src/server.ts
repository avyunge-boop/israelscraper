/**
 * HTTP API for Cloud Run: POST /run-scrape triggers the orchestrator.
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
      child = spawn(
        "pnpm",
        ["--filter", "@workspace/scraper", "run", "scan", "--", ...argv],
        { cwd: REPO_ROOT, env, shell }
      );
    } else {
      child = spawn(
        process.execPath,
        [
          path.join(SCRAPER_PKG_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
          path.join(SCRAPER_PKG_ROOT, "src", "orchestrator.ts"),
          ...argv,
        ],
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

app.post("/run-scrape", async (req, res) => {
  const body = (req.body ?? {}) as RunScrapeBody;
  const argv = buildOrchestratorArgv(body);
  try {
    const { code, stdout, stderr } = await runOrchestrator(argv);
    let uploaded: string[] = [];
    if (code === 0 && process.env.SCRAPER_STORAGE === "gcs") {
      try {
        uploaded = await uploadDataArtifactsToGcs();
      } catch (e) {
        return res.status(500).json({
          ok: false,
          exitCode: code,
          stdout,
          stderr,
          gcsError: String(e),
        });
      }
    }
    return res.status(code === 0 ? 200 : 500).json({
      ok: code === 0,
      exitCode: code,
      argv,
      stdout,
      stderr,
      gcsUploaded: uploaded,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

const port = Number(process.env.PORT || "8080");
app.listen(port, "0.0.0.0", () => {
  console.log(`[server] listening on 0.0.0.0:${port}`);
});
