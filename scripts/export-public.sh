#!/usr/bin/env bash
# Builds a local, single-commit public export of HEAD in <target-dir> and runs the safety check there.
# Usage: scripts/export-public.sh <target-dir>
#        scripts/export-public.sh --update <public-checkout>
# --update copies HEAD's tree over an existing public checkout (keeping its .git, deleting files that
# no longer exist), runs the safety check and leaves the changes uncommitted for the owner to review and commit.
# Never pushes and never adds a remote: publishing is a separate, manual step (docs/release/PUBLIC-RELEASE.md).
set -euo pipefail

# Review uncommitted changes in a sandbox that cannot write Git metadata.
if [ "${1:-}" = "--working-tree" ]; then
  [ $# -eq 2 ] || { echo "usage: $0 --working-tree <empty-target-dir>" >&2; exit 2; }
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  python3 "$script_dir/export-public-tree.py" "$2"
  node "$script_dir/check-public-safety.js" --root "$2" --config "$script_dir/public-safety-denylist.json" --exported
  exit 0
fi

if [ "${1:-}" = "--update" ]; then
  [ $# -eq 2 ] && [ -d "$2/.git" ] || { echo "usage: $0 --update <public-checkout>" >&2; exit 2; }
  upd="$(cd "$2" && pwd)"
  repo="$(git rev-parse --show-toplevel)"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  git -C "$repo" archive HEAD | tar -x -C "$tmp"
  rsync -a --delete --exclude=/.git/ "$tmp"/ "$upd"/
  cd "$upd"
  npm run check:public -- --exported
  echo "export-public: tree updated in $upd (nothing committed or pushed); review with 'git status', then commit and push there"
  exit 0
fi

if [ $# -ne 1 ] || [ -z "$1" ]; then
  echo "usage: $0 <target-dir>" >&2
  exit 2
fi
target="$1"
repo="$(git rev-parse --show-toplevel)"

if [ -e "$target" ] && [ -n "$(ls -A "$target" 2>/dev/null)" ]; then
  echo "export-public: $target exists and is not empty" >&2
  exit 2
fi

# Public history must not copy the private checkout's personal Git identity.
name="gopuda11"
email="gopuda11@users.noreply.github.com"

mkdir -p "$target"
git -C "$repo" archive HEAD | tar -x -C "$target"   # honours export-ignore in .gitattributes

# Reject unsafe material before creating the fresh public history.
node "$repo/scripts/check-public-safety.js" --root "$target" --config "$repo/scripts/public-safety-denylist.json" --exported

cd "$target"
git init -q -b main
git add -A
git -c user.name="gopuda11" -c user.email="$email" commit -q -m "Aigora: initial public release"
echo "export-public: committed $(git rev-parse --short HEAD) in $target (no remote configured, nothing pushed)"

# The tree must pass the safety check before anyone publishes it.
npm run check:public -- --exported
