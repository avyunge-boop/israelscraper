/**
 * HTTP API for Cloud Run: POST /run-scrape triggers the orchestrator (background).
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

function runScrapeInBackground(orchArgv: string[]): void {
  const child = spawnOrchestrator(orchArgv);

  child.on("error", (err) => {
    console.error("[run-scrape] failed to start child process:", err);
  });

  child.stdout?.on("data", (c: Buffer) => {
    console.log("[run-scrape] stdout:", c.toString("utf-8"));
  });

  child.stderr?.on("data", (c: Buffer) => {
    console.log("[run-scrape] stderr:", c.toString("utf-8"));
  });

  child.on("close", (code, signal) => {
    const exitCode = code ?? 1;
    if (exitCode !== 0) {
      console.error("[run-scrape] process exited with error", {
        exitCode,
        signal: signal ?? null,
      });
    } else {
      console.log("[run-scrape] process finished successfully (exit 0)");
    }

    if (exitCode === 0 && process.env.SCRAPER_STORAGE === "gcs") {
      void (async () => {
        try {
          console.log("[run-scrape] GCS upload starting…");
          const uploaded = await uploadDataArtifactsToGcs();
          console.log("[run-scrape] GCS upload finished:", uploaded);
        } catch (e) {
          console.error("[run-scrape] GCS upload failed:", e);
        }
      })();
    }
  });
}

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, service: "israel-scraper" });
});

/** Root — מונע 404 בפתיחת ה-URL בדפדפן / בדיקות בסיסיות; לא מבלבל עם תשתית Cloud Run */
app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    service: "israel-scraper-api",
    docs: "POST /run-scrape (JSON body: agency | all, optional refresh). See /health.",
  });
});

app.post("/run-scrape", (req, res) => {
  console.log("[run-scrape] HTTP request received");
  const body = (req.body ?? {}) as RunScrapeBody;
  const orchArgv = buildOrchestratorArgv(body);

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

  console.log("[run-scrape] enqueue background scrape, argv:", orchArgv);
  runScrapeInBackground(orchArgv);

  return res.status(202).json({ ok: true, status: "started" });
});

const port = Number(process.env.PORT || "8080");
app.listen(port, "0.0.0.0", () => {
  console.log(`[server] listening on 0.0.0.0:${port}`);
});
