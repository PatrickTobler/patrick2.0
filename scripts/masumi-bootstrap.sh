#!/bin/sh
# Import the masumi-agent-messenger backup once on container boot if not already authed.
set -e

if [ -z "$MASUMI_AGENT_BACKUP_B64" ] || [ -z "$MASUMI_AGENT_BACKUP_PASSPHRASE" ]; then
  echo "masumi-bootstrap: no backup env vars set, skipping"
  exit 0
fi

# Check if already authed
if masumi-agent-messenger --json auth status 2>/dev/null | grep -q '"authenticated": true'; then
  echo "masumi-bootstrap: already authed, skipping"
  exit 0
fi

TMP=$(mktemp)
echo "$MASUMI_AGENT_BACKUP_B64" | base64 -d > "$TMP"

if masumi-agent-messenger --json auth backup import --file "$TMP" --passphrase "$MASUMI_AGENT_BACKUP_PASSPHRASE" 2>&1; then
  echo "masumi-bootstrap: backup imported"
else
  echo "masumi-bootstrap: backup import failed (continuing)"
fi

rm -f "$TMP"
