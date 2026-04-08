/**
 * HTTP API for Cloud Run: POST /run-scrape triggers the orchestrator.
 * Set SCRAPER_STORAGE=gcs and GCS_BUCKET_NAME (default israelscraper) to upload data/*.json after a successful run.
 */
import { spawn } from "child_process";
import express from "express";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { uploadDataArtifactsToGcs } from "./gcs-sync.js";
import { loadRootEnv, REPO_ROOT } from "./repo-paths.js";

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
  const env = {
    ...process.env,
    SCRAPER_ORCHESTRATOR_SKIP_ALL_EMAIL: "1",
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

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, service: "israel-scraper" });
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
