#!/bin/sh
dir="$(dirname "$0")/../src-tauri"
[ -d "$dir/target" ] || exit 0
kb=$(du -sk "$dir/target" | cut -f1)
limit=$((15 * 1024 * 1024))
if [ "$kb" -gt "$limit" ]; then
  echo "Rust build cache is $((kb / 1024 / 1024)) GB, over 15 GB. Cleaning it; this build starts from scratch."
  cargo clean --manifest-path "$dir/Cargo.toml"
fi
