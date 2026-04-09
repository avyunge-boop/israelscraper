#!/usr/bin/env bash
set -euo pipefail

# Trigger Cloud Build for scraper-api (Dockerfile) and deploy to Cloud Run.
# Usage (from repo root):
#   ./scripts/gcp/trigger-scraper-cloud-build.sh
# Requires: gcloud auth, Cloud Build API enabled, Artifact Registry repo.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PROJECT_ID="${GCP_PROJECT_ID:-project-36c1b4ff-df0f-4c13-883}"

echo "Submitting Cloud Build in project: ${PROJECT_ID}"
echo "Config: cloudbuild.yaml (region/service via substitutions in file or flags)"

exec gcloud builds submit \
  --config="${ROOT}/cloudbuild.yaml" \
  --project="${PROJECT_ID}" \
  "${ROOT}"
