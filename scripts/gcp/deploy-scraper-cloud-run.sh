#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   GCP_PROJECT_ID=... GCP_REGION=... GCS_BUCKET_NAME=... ./scripts/gcp/deploy-scraper-cloud-run.sh

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID}"
REGION="${GCP_REGION:-us-central1}"
SERVICE_NAME="${SCRAPER_SERVICE_NAME:-israel-scraper}"
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

gcloud builds submit --tag "${IMAGE}" .

gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --platform managed \
  --allow-unauthenticated \
  --timeout=900 \
  --cpu=2 \
  --memory=2Gi \
  --set-env-vars "SCRAPER_STORAGE=gcs,GCS_BUCKET_NAME=${GCS_BUCKET_NAME:?Set GCS_BUCKET_NAME},GCP_PROJECT_ID=${PROJECT_ID}"

echo "Deployed scraper service: ${SERVICE_NAME}"
