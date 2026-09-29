#!/bin/bash
# Syncs the open-source repo from this one (the private repo, linguaclip-pro):
# the committed tree of HEAD, minus pro/, TASKS.md and docs/, lands as one commit on the
# public repo's main. Uncommitted changes here are never exported.
#
#   scripts/sync-public.sh "说明"   prepare + check that the free build compiles, then commit (no push)
#   scripts/sync-public.sh --push  push what the last run committed
set -euo pipefail

PUBLIC=https://github.com/Samuelxiaozhuofeng/video_dictation_local.git
ROOT=$(git rev-parse --show-toplevel)
WORK="$HOME/.cache/linguaclip-public"
EXCLUDE=(pro TASKS.md docs)

if [ "${1:-}" = "--push" ]; then
  [ "$(git -C "$WORK" remote get-url origin)" = "$PUBLIC" ] || { echo "工作副本不是公开仓库：$WORK"; exit 1; }
  git -C "$WORK" log --oneline -1
  git -C "$WORK" push origin main
  exit 0
fi
MSG=${1:?usage: scripts/sync-public.sh "说明" | --push}

if [ ! -d "$WORK/.git" ]; then
  git clone -q "$PUBLIC" "$WORK"
else
  git -C "$WORK" fetch -q origin
  git -C "$WORK" reset -q --hard origin/main
fi
[ "$(git -C "$WORK" remote get-url origin)" = "$PUBLIC" ] || { echo "工作副本不是公开仓库：$WORK"; exit 1; }

# Replace the whole tree with HEAD's.
find "$WORK" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git -C "$ROOT" archive HEAD | tar -x -C "$WORK"
for x in "${EXCLUDE[@]}"; do rm -rf "${WORK:?}/$x"; done

# Nothing may reach into pro/ except through the @pro alias.
if grep -rnE "(from |import\()['\"]((\.\.?/)+|@/)pro/" "$WORK" --include='*.ts' --include='*.tsx' --include='*.mjs'; then
  echo "上面这些文件直接引用了 pro/，开源版会编译不过"; exit 1
fi

# The free build must compile on its own.
ln -s "$ROOT/node_modules" "$WORK/node_modules"
trap 'rm -f "$WORK/node_modules"' EXIT
(cd "$WORK" && npx tsc --noEmit && npx vite build --logLevel error --outDir "$(mktemp -d)")
rm -f "$WORK/node_modules"

git -C "$WORK" add -A
if git -C "$WORK" diff --cached --quiet; then echo "开源版没有变化"; exit 0; fi
git -C "$WORK" diff --cached --stat | tail -15
git -C "$WORK" commit -q -m "$MSG"
[ -z "$(git -C "$ROOT" status --porcelain)" ] || echo "注意：本机还有没提交的改动，这次没带上"
echo "已在 $WORK 提交，检查无误后跑：scripts/sync-public.sh --push"
