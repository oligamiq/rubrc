#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_DIR="${1:-}"

if [ "$#" -ne 1 ]; then
  echo "Usage: bun run pages:preview-ci -- <rubrc-production-build-dir>" >&2
  exit 2
fi

ARTIFACT_DIR="$(cd "$ARTIFACT_DIR" && pwd)"
OUTPUT_DIR="${ARTIFACT_DIR%/}-pages-ready"

bash "$ROOT_DIR/scripts/prepare-ci-pages-dist.sh" "$ARTIFACT_DIR"
exec bun "$ROOT_DIR/scripts/preview-pages-dist.mjs" "$OUTPUT_DIR"
