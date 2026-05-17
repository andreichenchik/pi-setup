#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target_file="${1:-$source_dir/AGENTS.md}"
pi_note="$source_dir/AGENTS-PI.md"
prefix_note="${AGENTS_PREFIX_PATH:-}"
global_note="${AGENTS_GLOBAL_PATH:-$HOME/.config/agents/AGENTS.md}"

if [[ ! -f "$pi_note" ]]; then
  echo "Missing Pi agent note: $pi_note" >&2
  exit 1
fi

if [[ -n "$prefix_note" && ! -f "$prefix_note" ]]; then
  echo "Missing agent prefix note: $prefix_note" >&2
  exit 1
fi

mkdir -p "$(dirname "$target_file")"
temp_file="$(mktemp "${target_file}.tmp.XXXXXX")"
cleanup() {
  rm -f "$temp_file"
}
trap cleanup EXIT

first=1
append_note() {
  local file="$1"

  if [[ ! -f "$file" ]]; then
    return
  fi

  if [[ "$first" -eq 0 ]]; then
    printf '\n' >>"$temp_file"
  fi

  cat "$file" >>"$temp_file"
  if [[ -s "$temp_file" && "$(tail -c 1 "$temp_file")" != "" ]]; then
    printf '\n' >>"$temp_file"
  fi
  first=0
}

if [[ -n "$prefix_note" ]]; then
  append_note "$prefix_note"
fi
append_note "$pi_note"
append_note "$global_note"

mv "$temp_file" "$target_file"
trap - EXIT
