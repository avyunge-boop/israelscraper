#!/usr/bin/env bash
# Reverts cloud migration changes using cloud_migration_backup/.
# Run from repository root: ./emergency_restore.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP="$ROOT/cloud_migration_backup"

if [[ ! -d "$BACKUP/packages/scraper" ]] || [[ ! -d "$BACKUP/packages/frontend" ]]; then
  echo "error: missing $BACKUP/packages/{scraper,frontend} — backup incomplete or removed." >&2
  exit 1
fi

echo "Restoring scripts/ from backup (was saved as packages/scraper snapshot)..."
rm -rf "$ROOT/scripts"
mkdir -p "$ROOT/scripts"
cp -R "$BACKUP/packages/scraper/"* "$ROOT/scripts/"

echo "Restoring b_UUco9SpqaeI/ from backup (was saved as packages/frontend snapshot)..."
rm -rf "$ROOT/b_UUco9SpqaeI"
mkdir -p "$ROOT/b_UUco9SpqaeI"
cp -R "$BACKUP/packages/frontend/"* "$ROOT/b_UUco9SpqaeI/"

echo "Removing migration-only paths..."
rm -rf "$ROOT/packages/scraper" "$ROOT/packages/desktop" 2>/dev/null || true
rm -f "$ROOT/packages/scraper/Dockerfile" 2>/dev/null || true
rmdir "$ROOT/packages" 2>/dev/null || true

echo "Restoring root workspace files from backup (if present)..."
if [[ -f "$BACKUP/root/pnpm-workspace.yaml" ]]; then
  cp "$BACKUP/root/pnpm-workspace.yaml" "$ROOT/pnpm-workspace.yaml"
fi
if [[ -f "$BACKUP/root/package.json" ]]; then
  cp "$BACKUP/root/package.json" "$ROOT/package.json"
fi

echo "Removing deploy workflow (if added by migration)..."
rm -f "$ROOT/.github/workflows/deploy.yml" 2>/dev/null || true

echo "Removing Cloud Run Dockerfile / .dockerignore (migration defaults)..."
rm -f "$ROOT/Dockerfile" "$ROOT/.dockerignore" 2>/dev/null || true

echo "Done. Review with git status and reinstall: pnpm install"
echo "Optional: remove cloud_migration_backup/ after you confirm the tree is correct."
