#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_DIR="${1:-}"

fail() { echo "Error: $1" >&2; exit 2; }

[ "$#" -eq 1 ] || fail "Usage: bun run pages:prepare-ci -- <rubrc-production-build-dir>"
[ -d "$ARTIFACT_DIR" ] || fail "Artifact directory not found: $ARTIFACT_DIR"

ARTIFACT_DIR="$(cd "$ARTIFACT_DIR" && pwd)"
OUTPUT_DIR="${ARTIFACT_DIR%/}-pages-ready"
[ ! -e "$OUTPUT_DIR" ] || fail "Output already exists: $OUTPUT_DIR"

TMP_DIR="$(mktemp -d)"
PREPARED=0
cleanup() {
  rm -rf "$TMP_DIR"
  if [ "$PREPARED" -ne 1 ]; then rm -rf "$OUTPUT_DIR"; fi
}
trap cleanup EXIT

mkdir -p "$(dirname "$OUTPUT_DIR")"
cp -a "$ARTIFACT_DIR" "$OUTPUT_DIR"

# Normalize the shared artifact to the Cloudflare-native form. Older prepared
# artifacts may already contain the GitHub Pages-only mini-coi fallback.
rm -f "$OUTPUT_DIR/mini-coi.js"
node - "$OUTPUT_DIR/index.html" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
let html = fs.readFileSync(path, "utf8");
html = html.replace(
  /\s*<script\s+src=["']\.\/mini-coi\.js["']\s+scope=["']\.\/["']\s*><\/script>/g,
  "",
);
fs.writeFileSync(path, html);
NODE

node "$ROOT_DIR/scripts/prepare-vfs-asset.mjs" "$OUTPUT_DIR"

# Older production-build artifacts (including runs created before rust-src was
# bundled by CI) still expect the same-origin /rust-src.tar.vfsbr asset.
# Preserve an artifact-provided copy when present; otherwise backfill it from
# the installed toolchain used for local preview preparation.
if [ ! -s "$OUTPUT_DIR/rust-src.tar.vfsbr" ]; then
  (
    cd "$ROOT_DIR"
    deno run --no-lock --allow-read --allow-write --allow-run \
      "$ROOT_DIR/scripts/prepare_rust_src_asset.ts" \
      "$OUTPUT_DIR/rust-src.tar.vfsbr"
  )
fi
[ -s "$OUTPUT_DIR/rust-src.tar.vfsbr" ] || fail "rust-src asset was not prepared"

# Older CI artifacts also predate deployment metadata. The runtime treats it as
# optional cache-pruning input, so publish inert JSON instead of leaving a 404.
if [ ! -s "$OUTPUT_DIR/.rubrc-pages-build.json" ]; then
  printf '{}\n' > "$OUTPUT_DIR/.rubrc-pages-build.json"
fi

# _headers makes this directory directly deployable to Cloudflare Pages.
# GitHub Pages adds mini-coi in its deployment workflow.

touch "$OUTPUT_DIR/.nojekyll"
node "$ROOT_DIR/scripts/verify-vfs-asset.mjs" "$OUTPUT_DIR"

PREPARED=1
printf 'Prepared shared deploy/preview directory:\n%s\n' "$OUTPUT_DIR"
