import { spawn } from "child_process";
import express from "express";
import path from "path";
import { uploadDataArtifactsToGcs } from "./gcs-sync.js";
import { loadRootEnv, REPO_ROOT } from "./repo-paths.js";

loadRootEnv();

const ORCHESTRATOR_TS = path.join(REPO_ROOT, "packages/scraper/src/orchestrator.ts");

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

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, service: "israel-scraper" });
});

app.post("/run-scrape", (req, res) => {
  const body = (req.body ?? {}) as RunScrapeBody;
  const argv = buildOrchestratorArgv(body);

  console.log(`[server] Received run-scrape request. ARGV: ${argv.join(" ")}`);

  const env = { ...process.env, SCRAPER_ORCHESTRATOR_SKIP_ALL_EMAIL: "1" };
  
  console.log(`[server] Spawning: tsx ${ORCHESTRATOR_TS} ${argv.join(" ")}`);

  const child = spawn("tsx", [ORCHESTRATOR_TS, ...argv], { 
    cwd: REPO_ROOT, 
    env,
    shell: false 
  });

  child.stdout?.on("data", (data) => console.log(`[orchestrator]: ${data.toString().trim()}`));
  child.stderr?.on("data", (data) => console.error(`[orchestrator-err]: ${data.toString().trim()}`));

  child.on("close", async (code) => {
    console.log(`[server] Scraper exited with code ${code}`);
    if (code === 0 && process.env.SCRAPER_STORAGE === "gcs") {
      try {
        await uploadDataArtifactsToGcs();
        console.log("[server] GCS upload success");
      } catch (e) {
        console.error("[server] GCS upload failed", e);
      }
    }
  });

  return res.status(202).json({ ok: true, status: "started" });
});

const port = Number(process.env.PORT || "8080");
app.listen(port, "0.0.0.0", () => console.log(`[server] running on port ${port}`));
