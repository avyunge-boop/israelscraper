import { existsSync, readFileSync } from "fs"
import path from "path"

let ensured = false

function mergeEnvFromFile(filePath: string): void {
  if (!existsSync(filePath)) return
  try {
    const text = readFileSync(filePath, "utf-8")
    for (const line of text.split("\n")) {
      const t = line.trim()
      if (!t || t.startsWith("#")) continue
      const eq = t.indexOf("=")
      if (eq <= 0) continue
      const key = t.slice(0, eq).trim()
      let val = t.slice(eq + 1).trim()
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      const cur = process.env[key]
      const hasValue = cur !== undefined && String(cur).trim() !== ""
      if (hasValue) continue
      process.env[key] = val
    }
  } catch {
    /* */
  }
}

/**
 * Same order as next.config.mjs, plus paths for standalone Docker (cwd=/app) and monorepo dev.
 * Must run in the server process — next.config merge does not apply to a fresh `node server.js` runtime.
 */
function candidateEnvPaths(): string[] {
  const cwd = process.cwd()
  const parts = [
    path.join(cwd, "..", ".env"),
    path.join(cwd, ".env"),
    path.join(cwd, ".env.local"),
    path.join(cwd, "b_UUco9SpqaeI", ".env"),
    path.join(cwd, "b_UUco9SpqaeI", ".env.local"),
  ]
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of parts) {
    const n = path.normalize(p)
    if (seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

export function ensureDashboardEnvLoaded(): void {
  if (ensured) return
  ensured = true
  for (const f of candidateEnvPaths()) {
    mergeEnvFromFile(f)
  }
}
