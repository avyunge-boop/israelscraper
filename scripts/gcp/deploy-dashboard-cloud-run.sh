#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   GCP_PROJECT_ID=... GCP_REGION=... ./scripts/gcp/deploy-dashboard-cloud-run.sh
# Optional:
#   GROQ_API_KEY=... BUS_ALERTS_SMTP_HOST=... BUS_ALERTS_SMTP_USER=... BUS_ALERTS_SMTP_PASS=...

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
REGION="${GCP_REGION:-us-central1}"
SERVICE_NAME="${DASHBOARD_SERVICE_NAME:-israel-dashboard}"
REPOSITORY="${AR_REPOSITORY:-israel-scraper}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${SERVICE_NAME}:$(date +%Y%m%d-%H%M%S)"

gcloud config set project "${PROJECT_ID}"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com

if ! gcloud artifacts repositories describe "${REPOSITORY}" --location "${REGION}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${REPOSITORY}" \
    --repository-format docker \
    --location "${REGION}" \
    --description "Israel Scraper container images"
fi

gcloud builds submit --tag "${IMAGE}" -f Dockerfile.dashboard .

ENV_VARS=(
  "NODE_ENV=production"
  "SCRAPER_DATA_DIR=/tmp/israel-scraper-data"
)

if [[ -z "${SCRAPER_API_URL:-}" ]]; then
  echo "WARNING: SCRAPER_API_URL is unset — agency scans from Cloud Run need it (dashboard has no local pnpm orchestrator)." >&2
fi

[[ -n "${GROQ_API_KEY:-}" ]] && ENV_VARS+=("GROQ_API_KEY=${GROQ_API_KEY}")
[[ -n "${BUS_ALERTS_SMTP_HOST:-}" ]] && ENV_VARS+=("BUS_ALERTS_SMTP_HOST=${BUS_ALERTS_SMTP_HOST}")
[[ -n "${BUS_ALERTS_SMTP_PORT:-}" ]] && ENV_VARS+=("BUS_ALERTS_SMTP_PORT=${BUS_ALERTS_SMTP_PORT}")
[[ -n "${BUS_ALERTS_SMTP_SECURE:-}" ]] && ENV_VARS+=("BUS_ALERTS_SMTP_SECURE=${BUS_ALERTS_SMTP_SECURE}")
[[ -n "${BUS_ALERTS_SMTP_USER:-}" ]] && ENV_VARS+=("BUS_ALERTS_SMTP_USER=${BUS_ALERTS_SMTP_USER}")
[[ -n "${BUS_ALERTS_SMTP_PASS:-}" ]] && ENV_VARS+=("BUS_ALERTS_SMTP_PASS=${BUS_ALERTS_SMTP_PASS}")
[[ -n "${BUS_ALERTS_EMAIL_FROM:-}" ]] && ENV_VARS+=("BUS_ALERTS_EMAIL_FROM=${BUS_ALERTS_EMAIL_FROM}")
[[ -n "${BUS_ALERTS_EMAIL_TO:-}" ]] && ENV_VARS+=("BUS_ALERTS_EMAIL_TO=${BUS_ALERTS_EMAIL_TO}")
[[ -n "${SCRAPER_REPO_ROOT:-}" ]] && ENV_VARS+=("SCRAPER_REPO_ROOT=${SCRAPER_REPO_ROOT}")
[[ -n "${SCRAPER_API_URL:-}" ]] && ENV_VARS+=("SCRAPER_API_URL=${SCRAPER_API_URL}")

gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --platform managed \
  --allow-unauthenticated \
  --timeout=900 \
  --cpu=2 \
  --memory=2Gi \
  --set-env-vars "$(IFS=,; echo "${ENV_VARS[*]}")"

echo "Deployed dashboard service: ${SERVICE_NAME}"
