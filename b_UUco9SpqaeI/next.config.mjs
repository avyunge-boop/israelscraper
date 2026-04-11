import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
function mergeEnvFromFile(filePath) {
  if (!existsSync(filePath)) return
  const text = readFileSync(filePath, 'utf-8')
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const key = t.slice(0, eq).trim()
    let val = t.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  }
}

mergeEnvFromFile(path.join(__dirname, '..', '.env'))
mergeEnvFromFile(path.join(__dirname, '.env'))
mergeEnvFromFile(path.join(__dirname, '.env.local'))

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  /** Same-origin HTTP in Electron (127.0.0.1) — do not use a file:// or CDN prefix */
  assetPrefix: process.env.NEXT_ASSET_PREFIX?.trim() || '',
  outputFileTracingRoot: path.join(__dirname, '..'),
  outputFileTracingExcludes: {
    '*': [
      'cloud_migration_backup/**/*',
      '**/cloud_migration_backup/**/*',
      'packages/desktop/resources/scraper/**/*',
    ],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
