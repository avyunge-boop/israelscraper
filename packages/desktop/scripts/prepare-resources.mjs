#!/usr/bin/env node
/**
 * Stages Next.js standalone + a deployable scraper bundle (pnpm deploy) into packages/desktop/resources/
 * for electron-builder. Run: pnpm run desktop:prepare
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");
const resourcesDir = path.join(desktopDir, "resources");
const nextAppDir = path.join(repoRoot, "b_UUco9SpqaeI");
const scraperRel = "packages/desktop/resources/scraper";
const scraperDest = path.join(repoRoot, scraperRel);

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

rmrf(path.join(resourcesDir, "next"));
rmrf(scraperDest);
fs.mkdirSync(resourcesDir, { recursive: true });
fs.mkdirSync(path.dirname(scraperDest), { recursive: true });

console.log("[desktop:prepare] Building Next.js (standalone)…");
execSync("pnpm run build", {
  cwd: nextAppDir,
  stdio: "inherit",
  env: { ...process.env },
});

const standaloneSrc = path.join(nextAppDir, ".next", "standalone");
if (!fs.existsSync(standaloneSrc)) {
  throw new Error(
    "Missing b_UUco9SpqaeI/.next/standalone — enable output: 'standalone' in next.config.mjs"
  );
}

const nextDest = path.join(resourcesDir, "next");
fs.cpSync(standaloneSrc, nextDest, { recursive: true });

/**
 * Monorepo standalone output puts server.js under e.g. next/b_UUco9SpqaeI/
 * (see outputFileTracingRoot). Next does chdir to that folder and serves
 * /_next/static from <that>/.next/static — not from next/.next/static.
 */
function resolveStandaloneServerDir(root) {
  const direct = path.join(root, "server.js");
  if (fs.existsSync(direct)) return root;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory() || e.name === "node_modules") continue;
    const nested = path.join(root, e.name, "server.js");
    if (fs.existsSync(nested)) return path.join(root, e.name);
  }
  throw new Error(
    `No server.js under ${root} — check Next standalone output and outputFileTracingRoot.`
  );
}

const serverDir = resolveStandaloneServerDir(nextDest);

const staticSrc = path.join(nextAppDir, ".next", "static");
const staticDest = path.join(serverDir, ".next", "static");
if (fs.existsSync(staticSrc)) {
  fs.mkdirSync(path.dirname(staticDest), { recursive: true });
  fs.cpSync(staticSrc, staticDest, { recursive: true });
}

const publicSrc = path.join(nextAppDir, "public");
if (fs.existsSync(publicSrc)) {
  fs.cpSync(publicSrc, path.join(serverDir, "public"), { recursive: true });
}

console.log("[desktop:prepare] pnpm deploy scraper bundle…");
execSync(
  `pnpm --filter @workspace/scraper deploy "${scraperRel}" --prod --legacy`,
  {
    cwd: repoRoot,
    stdio: "inherit",
  }
);

/**
 * האפליקציה המותקנת מריצה את האורקסטרטור עם node — לא tsx (tsx→esbuild חסר
 * @esbuild/darwin-* אחרי pnpm deploy). קובץ ESM אחד, תלות ב-node_modules של ה-deploy.
 */
const scraperPkg = path.join(repoRoot, "packages", "scraper");
const orchestratorBundle = path.join(scraperDest, "dist", "orchestrator.mjs");
fs.mkdirSync(path.dirname(orchestratorBundle), { recursive: true });
console.log("[desktop:prepare] Bundling orchestrator.mjs (no tsx/esbuild at runtime)…");
execSync(
  `pnpm exec esbuild src/orchestrator.ts --bundle --platform=node --format=esm --target=node20 --outfile="${orchestratorBundle}" --packages=external`,
  {
    cwd: scraperPkg,
    stdio: "inherit",
    env: { ...process.env },
  }
);

const cacheDir = path.join(scraperDest, "chromium-cache");
fs.mkdirSync(cacheDir, { recursive: true });
console.log("[desktop:prepare] Puppeteer Chromium → chromium-cache…");
execSync("npx puppeteer browsers install chrome", {
  cwd: scraperDest,
  stdio: "inherit",
  env: { ...process.env, PUPPETEER_CACHE_DIR: cacheDir },
});

console.log("[desktop:prepare] Done. Run: pnpm --filter @workspace/desktop run build:dmg");
