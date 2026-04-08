# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Dashboard

- **URL**: `/api/` (served by the API Server artifact)
- Reads `bus-alerts.json` via `GET /api/bus-alerts` endpoint (served from `artifacts/api-server/public/index.html`)
- Hebrew RTL layout with filter tabs (all / active / upcoming / expired) and free-text search
- Each alert card shows: agency, route ID, status badge, condition type, title, date range, and expandable full content

## Scripts

- `pnpm --filter @workspace/scripts run scrape-bus-alerts` — scrape bus route alerts from busnearby.co.il and save to `bus-alerts.json` at the workspace root
  - **Phase 1**: Puppeteer visits 19 agency pages to collect all route URLs (~3,700+ routes)
  - **Phase 2**: Direct REST API calls (`api.busnearby.co.il/directions/patch/routeAlerts/{routeId}`) run 10 in parallel — no full-page loads needed
  - **Alert API**: `GET https://api.busnearby.co.il/directions/patch/routeAlerts/{routeId}?locale=he`
  - **Output format**: `{ source, scrapedAt, agenciesChecked, uniqueRoutesChecked, count, alerts: [{ agencyId, agencyName, routeUrl, routeId, apiRouteId, alertId, title, fullContent, effectiveStart?, effectiveEnd?, activeNow, expired, stopConditions, affectedStop?, scrapedAt }] }`
  - Requires system Chromium (installed via Nix); runs in ~6 minutes total

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
