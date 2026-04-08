/**
 * Puppeteer resolves config from the package that depends on puppeteer (@workspace/scripts).
 * Delegate to the monorepo root so the browser cache is shared at <repo>/.cache/puppeteer.
 */
module.exports = require("../.puppeteerrc.cjs")
