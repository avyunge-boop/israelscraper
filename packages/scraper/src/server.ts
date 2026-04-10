/**
 * HTTP API for Cloud Run: POST /run-scrape starts the orchestrator in the background (returns immediately;
 * use GET /status and GET /last-result to track completion — avoids HTTP request timeouts on long runs).
 * Set SCRAPER_STORAGE=gcs and GCS_BUCKET_NAME to upload data/*.json after a successful run.
 */
import { spawn, type ChildProcess } from "child_process";
import express from "express";
import { existsSync } from "fs";
import path from "path";

import { uploadDataArtifactsToGcs } from "./gcs-sync.js";
import { loadRootEnv, REPO_ROOT } from "./repo-paths.js";

loadRootEnv();

const ORCHESTRATOR_TS = path.resolve(
  REPO_ROOT,
  "packages/scraper/src/orchestrator.ts"
);

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

/** Orchestrator prints JSON summaries per agent; at least one `"ok": true` means partial success. */
function orchestratorHadAnySuccessfulAgent(stdout: string): boolean {
  return /"ok"\s*:\s*true/.test(stdout);
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

function spawnOrchestrator(orchArgv: string[]): ChildProcess {
  const env = {
    ...process.env,
    SCRAPER_ORCHESTRATOR_SKIP_ALL_EMAIL: "1",
  };

  console.log("[run-scrape] spawning");
  console.log("[run-scrape] executable: tsx");
  console.log("[run-scrape] script:", ORCHESTRATOR_TS);
  console.log("[run-scrape] args:", JSON.stringify(orchArgv));
  console.log("[run-scrape] cwd:", REPO_ROOT);
  console.log("[run-scrape] shell: true");

  return spawn("tsx", [ORCHESTRATOR_TS, ...orchArgv], {
    cwd: REPO_ROOT,
    env,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function clearScrapeJob(): void {
  scrapeJob.running = false;
  scrapeJob.startedAt = null;
  scrapeJob.agency = "";
}

function runScrapeInBackground(orchArgv: string[]): void {
  const child = spawnOrchestrator(orchArgv);
  const out: Buffer[] = [];
  const err: Buffer[] = [];

  child.on("error", (spawnErr) => {
    console.error("[run-scrape] failed to start child process:", spawnErr);
    lastScrapeResult = {
      exitCode: 1,
      gcsUploaded: [],
      stdout: "",
      stderr: String(spawnErr),
      completedAt: new Date().toISOString(),
    };
    clearScrapeJob();
  });

  child.stdout?.on("data", (c: Buffer) => {
    out.push(Buffer.from(c));
    console.log("[run-scrape] stdout:", c.toString("utf-8"));
  });

  child.stderr?.on("data", (c: Buffer) => {
    err.push(Buffer.from(c));
    console.log("[run-scrape] stderr:", c.toString("utf-8"));
  });

  child.on("close", (code, signal) => {
    void (async () => {
      try {
        const exitCode = code ?? 1;
        const stdout = Buffer.concat(out).toString("utf-8");
        const stderr = Buffer.concat(err).toString("utf-8");

        if (exitCode !== 0) {
          console.error("[run-scrape] process exited with error", {
            exitCode,
            signal: signal ?? null,
          });
        } else {
          console.log("[run-scrape] process finished successfully (exit 0)");
        }

        let uploaded: string[] = [];
        let gcsError: string | undefined;
        const shouldUploadGcs =
          process.env.SCRAPER_STORAGE === "gcs" &&
          (exitCode === 0 || orchestratorHadAnySuccessfulAgent(stdout));
        if (shouldUploadGcs) {
          try {
            console.log("[run-scrape] GCS upload starting…");
            uploaded = await uploadDataArtifactsToGcs();
            console.log("[run-scrape] GCS upload finished:", uploaded);
          } catch (e) {
            gcsError = String(e);
            console.error("[run-scrape] GCS upload failed:", e);
          }
        }

        lastScrapeResult = {
          exitCode,
          gcsUploaded: uploaded,
          stdout,
          stderr,
          completedAt: new Date().toISOString(),
          ...(gcsError !== undefined ? { gcsError } : {}),
        };
        console.log(
          `[server] scrape finished exit=${exitCode} gcs=${uploaded.length}${gcsError ? ` gcsError=${gcsError}` : ""}`
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
        console.error(`[server] scrape finalize failed: ${msg}`);
      } finally {
        clearScrapeJob();
      }
    })();
  });
}

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

/** Root — מונע 404 בפתיחת ה-URL בדפדפן / בדיקות בסיסיות; לא מבלבל עם תשתית Cloud Run */
app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "israel-scraper-api",
    docs: "POST /run-scrape (JSON body: agency | all, optional refresh). GET /status, GET /last-result. See /health.",
  });
});

app.post("/run-scrape", (req, res) => {
  console.log("[run-scrape] HTTP request received");
  const body = (req.body ?? {}) as RunScrapeBody;
  const orchArgv = buildOrchestratorArgv(body);

  if (scrapeJob.running) {
    return res.status(409).json({
      ok: false,
      error: "scrape already running",
      agency: scrapeJob.agency,
    });
  }

  if (!existsSync(ORCHESTRATOR_TS)) {
    console.error(
      "[run-scrape] orchestrator file missing; expected at:",
      ORCHESTRATOR_TS
    );
    return res.status(503).json({
      ok: false,
      error: "orchestrator not found on filesystem",
      lookedFor: ORCHESTRATOR_TS,
      repoRoot: REPO_ROOT,
    });
  }

  const label = scrapeLabel(body);
  scrapeJob.running = true;
  scrapeJob.agency = label;
  scrapeJob.startedAt = new Date().toISOString();

  console.log("[run-scrape] enqueue background scrape, argv:", orchArgv);
  runScrapeInBackground(orchArgv);

  return res.status(200).json({ ok: true, started: true, agency: label });
});

const port = Number(process.env.PORT || "8080");
app.listen(port, "0.0.0.0", () => {
  console.log(`[server] listening on 0.0.0.0:${port}`);
});
