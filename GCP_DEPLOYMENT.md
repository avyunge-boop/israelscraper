# GCP Deployment Plan (24/7)

## Recommended architecture

- **Dashboard**: deploy `b_UUco9SpqaeI` to **Cloud Run service** (always-on HTTP UI/API).
- **Scraper execution**: trigger via HTTP endpoint (`packages/scraper/src/server.ts`) or move periodic runs to **Cloud Scheduler -> Cloud Run**.
- **Storage**: canonical JSON artifacts in **GCS** (`SCRAPER_STORAGE=gcs`, `GCS_BUCKET_NAME`).

For this workload, Cloud Run is the best default path: easy autoscaling, lower ops burden than Compute Engine, and native integration with Scheduler + Secret Manager.

## Docker images

- Scraper/API image: root `Dockerfile` (Chromium + headless deps included).
- Dashboard image: `Dockerfile.dashboard` (Next standalone runtime).

## Cloud Build configs

- `cloudbuild.yaml` — builds **`Dockerfile`** and deploys the **scraper-api** service (default `_SERVICE=scraper-api`). It does **not** build the Next dashboard.
- `cloudbuild.dashboard.yaml` — builds **`Dockerfile.dashboard`** and deploys the **dashboard** Cloud Run service. Pass `_SCRAPER_API_URL` so the UI can call `POST /run-scrape` on the scraper service (same value as the scraper’s public base URL, no trailing slash).

## Deployment scripts

- `scripts/gcp/deploy-scraper-cloud-run.sh`
- `scripts/gcp/deploy-dashboard-cloud-run.sh`

Both scripts build with Cloud Build and deploy to Cloud Run.

## Required environment variables

Set these in Cloud Run (prefer Secret Manager for secrets):

- **Dashboard service:** `SCRAPER_API_URL` — base URL of the scraper Cloud Run service (e.g. `https://scraper-api-….run.app`). Without it, agency/Bus Nearby scans cannot run on the dashboard container (there is no bundled repo for `pnpm scan`).
- `GCP_PROJECT_ID`
- `GCS_BUCKET_NAME`
- `SCRAPER_STORAGE=gcs`
- `GROQ_API_KEY`
- `BUS_ALERTS_SMTP_HOST`
- `BUS_ALERTS_SMTP_PORT` (default `587`)
- `BUS_ALERTS_SMTP_SECURE` (`1` for TLS, else `0`)
- `BUS_ALERTS_SMTP_USER`
- `BUS_ALERTS_SMTP_PASS`
- `BUS_ALERTS_EMAIL_FROM`
- `BUS_ALERTS_EMAIL_TO`

## Local dry-run protocol (Verify Before Reporting)

Run these before claiming cloud readiness:

1. Build images:
   - `docker build -t israel-scraper:local .`
   - `docker build -f Dockerfile.dashboard -t israel-dashboard:local .`
2. Start scraper container and hit:
   - `GET /health`
   - `POST /run-scrape` with `{"agency":"egged"}`
3. Start dashboard container and verify:
   - `GET /` returns `200`
   - `/_next/static/...` returns `200` (no 404)
4. Trigger test email flow:
   - `POST /api/send-alerts-email` with SMTP env configured
   - verify success in logs (`sent` > 0 or SMTP accepted message)
5. Reject deployment if logs include:
   - `404` on static assets
   - path resolution errors
   - SMTP/auth failures
