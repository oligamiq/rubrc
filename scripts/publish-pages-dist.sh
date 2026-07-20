#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/.." &&
  pwd
)"
cd "$ROOT_DIR"

fail() {
  echo "Error: $1" >&2
  exit 1
}

# 4.1 事前条件
command -v gh >/dev/null 2>&1 || fail "gh is not installed"
gh auth status >/dev/null 2>&1 || fail "gh is not authenticated"
test "$(git branch --show-current)" = "main" || fail "Current branch must be main"
test -z "$(git status --porcelain)" || fail "Working tree must be clean"

git fetch --quiet origin main

SOURCE_SHA="$(git rev-parse HEAD)"
REMOTE_MAIN_SHA="$(git rev-parse origin/main)"
test "$SOURCE_SHA" = "$REMOTE_MAIN_SHA" || fail "Local HEAD must equal origin/main"

# 4.2 ローカルビルド
rm -rf page/dist

bun install --frozen-lockfile
bun run build:prod
bun run vfs:prepare:prod

(
  cd page
  bunx mini-coi -sw dist/mini-coi.js
  sed -i '/<head>/a \    <script src="./mini-coi.js" scope="./"></script>' dist/index.html
)



# 4.4 metadata
SOURCE_SHA="$SOURCE_SHA" node -e "
const fs = require('fs');
fs.writeFileSync('page/dist/.rubrc-pages-build.json', JSON.stringify({
  version: 1,
  sourceSha: process.env.SOURCE_SHA
}, null, 2));
"

node scripts/verify-vfs-asset.mjs page/dist
touch page/dist/.nojekyll
node scripts/verify-vfs-asset.mjs page/dist

# 5. pages-distを独立一時リポジトリからpush
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

SITE_REPO="$TEMP_DIR/site"
mkdir -p "$SITE_REPO"

cp -a page/dist/. "$SITE_REPO/"

git -C "$SITE_REPO" init --quiet
git -C "$SITE_REPO" config user.name "rubrc-pages-publisher"
git -C "$SITE_REPO" config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git -C "$SITE_REPO" add --all
git -C "$SITE_REPO" commit --quiet -m "Deploy Pages for ${SOURCE_SHA}"

DIST_SHA="$(git -C "$SITE_REPO" rev-parse HEAD)"
REMOTE_URL="$(git remote get-url origin)"

REMOTE_DIST_SHA="$(
  git ls-remote \
    "$REMOTE_URL" \
    refs/heads/pages-dist |
  awk '{print $1}'
)"

if [ -z "$REMOTE_DIST_SHA" ]; then
  git -C "$SITE_REPO" push \
    "$REMOTE_URL" \
    HEAD:refs/heads/pages-dist
else
  git -C "$SITE_REPO" push \
    --force-with-lease="refs/heads/pages-dist:${REMOTE_DIST_SHA}" \
    "$REMOTE_URL" \
    HEAD:refs/heads/pages-dist
fi

# 6. workflowの起動
REPOSITORY="$(
  gh repo view \
    --json nameWithOwner \
    --jq '.nameWithOwner'
)"

echo "source SHA: $SOURCE_SHA"
echo "pages-dist SHA: $DIST_SHA"

if gh workflow run static.yml \
  --repo "$REPOSITORY" \
  --ref main \
  -f source_sha="$SOURCE_SHA" \
  -f dist_sha="$DIST_SHA"; then
  echo "デプロイworkflowを起動しました"
else
  fail "pages-distのpushまでは成功済みですが、workflow起動に失敗しました"
fi
