import { existsSync, readFileSync } from "fs"
import { readFile } from "fs/promises"
import path from "path"

/**
 * שורשים אפשריים של ה-workspace (אפליקציית Next, שורש repo, וכו').
 * מאפשר קריאת data/*.json ו-scan-export ללא תלות ב-cwd.
 */
export function getWorkspaceRoots(): string[] {
  const cwd = path.resolve(process.cwd())
  const roots = new Set<string>([cwd])
  const parent = path.resolve(cwd, "..")
  roots.add(parent)
  const nestedApp = path.join(cwd, "b_UUco9SpqaeI")
  if (existsSync(path.join(nestedApp, "package.json"))) {
    roots.add(path.resolve(nestedApp))
  }
  if (path.basename(cwd) === "b_UUco9SpqaeI") {
    roots.add(parent)
  }
  return [...roots]
}

/**
 * תיקיית data קנונית: תמיד `שורש-repo/data/`
 * (איחוד עם סקרייפרים — scan-export, bus-alerts, ai-summaries, settings).
 */
export function resolveCanonicalDataDir(): string {
  const fromEnv = process.env.SCRAPER_DATA_DIR?.trim()
  if (fromEnv) return path.resolve(fromEnv)
  return path.join(resolveOrchestratorRepoRoot(), "data")
}

/** קורא את הקובץ הראשון מרשימת נתיבים מוחלטים שנמצא */
export async function tryReadJsonFirstExisting(
  absolutePaths: string[]
): Promise<unknown | null> {
  for (const p of absolutePaths) {
    try {
      const text = await readFile(p, "utf-8")
      return JSON.parse(text) as unknown
    } catch {
      /* */
    }
  }
  return null
}

/** בונה נתיבים: כל שילוב root × segment trails */
export function expandWorkspacePaths(trails: string[][]): string[] {
  const roots = getWorkspaceRoots()
  const out: string[] = []
  for (const root of roots) {
    for (const segs of trails) {
      out.push(path.join(root, ...segs))
    }
  }
  return out
}

/** שורש ה-repo להרצת pnpm scan (יש packages/scraper או scripts ישן) — לא תלוי ב-cwd של Next */
export function resolveOrchestratorRepoRoot(): string {
  const fromEnv = process.env.SCRAPER_REPO_ROOT?.trim()
  if (fromEnv) return path.resolve(fromEnv)
  const cwd = path.resolve(process.cwd())
  if (existsSync(path.join(cwd, "packages", "scraper", "package.json"))) return cwd
  if (existsSync(path.join(cwd, "scripts", "package.json"))) return cwd
  if (path.basename(cwd) === "b_UUco9SpqaeI") {
    return path.resolve(cwd, "..")
  }
  if (
    existsSync(path.join(cwd, "b_UUco9SpqaeI", "package.json")) &&
    (existsSync(path.join(cwd, "packages", "scraper", "package.json")) ||
      existsSync(path.join(cwd, "scripts", "package.json")))
  ) {
    return cwd
  }
  return path.resolve(cwd, "..")
}

/**
 * true אם אין מסלולי Bus Nearby תקפים ב־data/routes-database.json
 * (חסר, JSON שבור, {}, routes ריק, או רשומות בלי patternId).
 */
export function isBusnearbyRoutesDatabaseEmpty(): boolean {
  const p = path.join(resolveCanonicalDataDir(), "routes-database.json")
  if (!existsSync(p)) return true
  try {
    const raw = readFileSync(p, "utf-8").trim()
    if (!raw) return true
    const j = JSON.parse(raw) as unknown
    if (j === null || typeof j !== "object" || Array.isArray(j)) return true
    const routes = (j as { routes?: unknown }).routes
    if (!Array.isArray(routes)) return true
    let valid = 0
    for (const r of routes) {
      if (r && typeof r === "object" && !Array.isArray(r)) {
        const pid = String((r as { patternId?: string }).patternId ?? "").trim()
        if (pid) valid++
      }
    }
    return valid === 0
  } catch {
    return true
  }
}
