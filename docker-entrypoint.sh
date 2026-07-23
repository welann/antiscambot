#!/bin/sh
set -eu

defaults_dir="${DEFAULTS_DIR:-/app/defaults}"
init_marker="${DIGEST_DATA_INIT_MARKER:-/app/data/.defaults-initialized}"

initialize_file() {
  target_file="$1"
  default_file="$2"

  mkdir -p "$(dirname "$target_file")"
  if [ ! -s "$target_file" ] && [ -f "$default_file" ]; then
    cp "$default_file" "$target_file"
  fi
}

if [ ! -e "$init_marker" ]; then
  initialize_file "$KEYWORDS_FILE" "$defaults_dir/keywords.txt"
  mkdir -p "$(dirname "$init_marker")"
  : > "$init_marker"
fi

exec "$@"
