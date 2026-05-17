#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target_dir="${1:-$source_dir/../container-agent}"

if [[ -n "$(git -C "$source_dir" status --porcelain)" ]]; then
  echo "Refusing to refresh container-agent snapshot: commit or stash ~/.pi/agent changes first." >&2
  exit 1
fi

mkdir -p "$target_dir"
find "$target_dir" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +

git -C "$source_dir" archive HEAD | tar -x -C "$target_dir"

mv "$target_dir/README.md" "$target_dir/README-HOST.md"
mv "$target_dir/README-CONTAINER.md" "$target_dir/README.md"
AGENTS_PREFIX_PATH="$source_dir/AGENTS-CONTAINER.md" "$source_dir/refresh-agents.md.sh" "$target_dir/AGENTS.md"

for file in .env auth.json settings.json models.json; do
  if [[ -f "$source_dir/$file" ]]; then
    cp -p "$source_dir/$file" "$target_dir/$file"
  fi
done
