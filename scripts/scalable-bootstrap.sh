#!/bin/sh
# Seed scalable-cli config to use file-based storage. Railway containers don't
# have DBus / Secret Service, so the default `keyring` session backend fails.
# Idempotent — never overwrites an existing config.toml.
set -e

CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/scalable-cli"
CFG_FILE="$CFG_DIR/config.toml"

mkdir -p "$CFG_DIR"

if [ -f "$CFG_FILE" ]; then
  echo "scalable-bootstrap: $CFG_FILE already present, leaving alone"
  exit 0
fi

cat > "$CFG_FILE" <<'TOML'
[auth]
session_backend = "file"
signing_key_backend = "file"
TOML

echo "scalable-bootstrap: seeded $CFG_FILE"
