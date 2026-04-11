import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"

import {
  fetchScraperDataJson,
  getScraperApiBaseUrl,
} from "@/lib/server/scraper-api"
import { resolveCanonicalDataDir } from "@/lib/server/workspace-paths"

function settingsPath(): string {
  return path.join(resolveCanonicalDataDir(), "settings.json")
}

export interface AppSettings {
  recipientEmail?: string
}

export async function readAppSettings(): Promise<AppSettings> {
  if (getScraperApiBaseUrl()) {
    const remote = await fetchScraperDataJson("settings.json")
    if (remote !== null && typeof remote === "object") {
      const j = remote as AppSettings
      const email =
        typeof j.recipientEmail === "string" ? j.recipientEmail.trim() : ""
      return { recipientEmail: email || undefined }
    }
  }
  try {
    const raw = await readFile(settingsPath(), "utf-8")
    const j = JSON.parse(raw) as AppSettings
    const email =
      typeof j.recipientEmail === "string" ? j.recipientEmail.trim() : ""
    return { recipientEmail: email || undefined }
  } catch {
    return {}
  }
}

export async function writeAppSettings(settings: AppSettings): Promise<void> {
  const dir = resolveCanonicalDataDir()
  await mkdir(dir, { recursive: true })
  const prev = await readAppSettings()
  const next: AppSettings = {
    ...prev,
    ...settings,
    recipientEmail:
      typeof settings.recipientEmail === "string"
        ? settings.recipientEmail.trim() || undefined
        : prev.recipientEmail,
  }
  await writeFile(settingsPath(), JSON.stringify(next, null, 2), "utf-8")
}
