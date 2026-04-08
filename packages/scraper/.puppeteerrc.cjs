/**
 * Puppeteer config for @workspace/scraper. Self-contained so `pnpm deploy` / desktop
 * bundles work without the monorepo root `.puppeteerrc.cjs`.
 */
const path = require("path");

module.exports = {
  cacheDirectory: path.join(__dirname, ".cache", "puppeteer"),
};
