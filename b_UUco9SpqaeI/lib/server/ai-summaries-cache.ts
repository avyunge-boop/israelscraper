import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"

import {
  getWorkspaceRoots,
  resolveCanonicalDataDir,
  resolveOrchestratorRepoRoot,
} from "@/lib/server/workspace-paths"

export type AiSummariesFile = {
  /** מפתח = מזהה התראה יציב (כמו ב־TransportAlert.id) */
  byId: Record<string, string>
}

/**
 * כל הנתיבים האפשריים לקריאה (מיזוג): env, data/ ליד cwd, או b_UUco9SpqaeI/data כש־cwd הוא שורש ה-workspace.
 * כתיבה: קובץ קנוני אחד — אותו נתיב שה-API והסקרייפר ישתמשו בו.
 */
function collectReadPaths(): string[] {
  const cwd = process.cwd()
  const seen = new Set<string>()
  const add = (p: string) => {
    const abs = path.isAbsolute(p) ? path.normalize(p) : path.normalize(path.join(cwd, p))
    seen.add(abs)
  }

  const env = process.env.AI_SUMMARIES_JSON_PATH?.trim()
  if (env) add(env)

  add(path.join(resolveOrchestratorRepoRoot(), "data", "ai-summaries.json"))

  // מפורשות ליד cwd + כל שורשי workspace (data/ ו־b_UUco9SpqaeI/data/)
  add(path.join(cwd, "data", "ai-summaries.json"))
  add(path.join(cwd, "b_UUco9SpqaeI", "data", "ai-summaries.json"))

  for (const root of getWorkspaceRoots()) {
    add(path.join(root, "data", "ai-summaries.json"))
    add(path.join(root, "b_UUco9SpqaeI", "data", "ai-summaries.json"))
  }

  return [...seen]
}

/** קובץ יעד לכתיבה — תואם ל־settings ול־data הקנוני */
export function resolveAiSummariesWritePath(): string {
  const cwd = process.cwd()
  if (process.env.AI_SUMMARIES_JSON_PATH?.trim()) {
    const p = process.env.AI_SUMMARIES_JSON_PATH.trim()
    return path.isAbsolute(p) ? path.normalize(p) : path.normalize(path.join(cwd, p))
  }
  return path.join(resolveCanonicalDataDir(), "ai-summaries.json")
}

function mergeById(
  target: Record<string, string>,
  incoming: Record<string, unknown>
): void {
  if (!incoming || typeof incoming !== "object") return
  for (const [k, v] of Object.entries(incoming)) {
    if (typeof v === "string" && v.trim()) target[k] = v.trim()
  }
}

/** קורא וממזג את כל קבצי המטמון שנמצאים — כדי שלא יאבדו סיכומים בגלל cwd שונה */
export async function readAiSummariesCache(): Promise<AiSummariesFile> {
  const byId: Record<string, string> = {}
  for (const file of collectReadPaths()) {
    try {
      const raw = await readFile(file, "utf-8")
      const j = JSON.parse(raw) as { byId?: Record<string, unknown> }
      if (j?.byId && typeof j.byId === "object") {
        mergeById(byId, j.byId)
      }
    } catch {
      /* קובץ חסר או פגום */
    }
  }
  return { byId }
}

export async function writeAiSummariesCache(cache: AiSummariesFile): Promise<void> {
  const file = resolveAiSummariesWritePath()
  const dir = path.dirname(file)
  await mkdir(dir, { recursive: true })
  await writeFile(file, JSON.stringify(cache, null, 2), "utf-8")
}
