/**
 * Runs once when the server starts. Dynamic import keeps `fs` out of the Edge bundle.
 * Ensures GROQ_API_KEY and SMTP from .env / .env.local are on process.env (standalone `node server.js`
 * does not re-run next.config.mjs merge).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureDashboardEnvLoaded } = await import(
      "./lib/server/env-bootstrap"
    )
    ensureDashboardEnvLoaded()
  }
}
