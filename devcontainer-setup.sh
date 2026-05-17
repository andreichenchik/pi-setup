#!/usr/bin/env bash
# Copy this mounted Pi snapshot into the devcontainer and install package dependencies.
set -euo pipefail

snapshot_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
target_dir="${1:-$HOME/.pi/agent}"

if [[ -z "${PI_CODING_AGENT_SESSION_DIR:-}" ]]; then
  echo "PI_CODING_AGENT_SESSION_DIR must be set explicitly." >&2
  exit 1
fi
session_dir="$PI_CODING_AGENT_SESSION_DIR"

[[ -f "$snapshot_dir/package.json" && -f "$snapshot_dir/pnpm-lock.yaml" ]] || { echo "Incomplete Pi snapshot: $snapshot_dir" >&2; exit 1; }
[[ -n "$target_dir" && "$target_dir" != "/" ]] || { echo "Unsafe Pi target: $target_dir" >&2; exit 1; }

mkdir -p "$(dirname -- "$target_dir")" "$session_dir"
target_parent="$(cd -- "$(dirname -- "$target_dir")" && pwd -P)"
target_real="$target_parent/$(basename -- "$target_dir")"
[[ "$target_real" != "$snapshot_dir" ]] || { echo "Refusing to copy Pi snapshot onto itself: $target_real" >&2; exit 1; }

rm -rf "$target_real"
mkdir -p "$target_real"
cp -a "$snapshot_dir"/. "$target_real"/

cd "$target_real"
pnpm install --prod
