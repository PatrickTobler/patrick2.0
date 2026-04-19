#!/bin/bash
# Wise Bank API helper — reads WISE_API_TOKEN from env. Outputs raw JSON.
set -e

if [ -z "$WISE_API_TOKEN" ]; then
  echo '{"error":"WISE_API_TOKEN env var not set"}' >&2
  exit 1
fi

BASE_URL="https://api.wise.com"

wise_curl() {
  curl -s -H "Authorization: Bearer $WISE_API_TOKEN" "$BASE_URL$1"
}

case "$1" in
  profiles)
    wise_curl "/v2/profiles"
    ;;
  balances)
    PROFILE_ID="${2:?Usage: wise_query.sh balances <profileId>}"
    wise_curl "/v4/profiles/$PROFILE_ID/balances?types=STANDARD,SAVINGS"
    ;;
  activities)
    PROFILE_ID="${2:?Usage: wise_query.sh activities <profileId> [size]}"
    SIZE="${3:-10}"
    wise_curl "/v1/profiles/$PROFILE_ID/activities?size=$SIZE"
    ;;
  rate)
    SOURCE="${2:?Usage: wise_query.sh rate <source> <target>}"
    TARGET="${3:?Usage: wise_query.sh rate <source> <target>}"
    wise_curl "/v1/rates?source=$SOURCE&target=$TARGET"
    ;;
  accounts)
    PROFILE_ID="${2:?Usage: wise_query.sh accounts <profileId>}"
    wise_curl "/v1/profiles/$PROFILE_ID/account-details"
    ;;
  *)
    echo "Usage: $0 {profiles|balances|activities|rate|accounts} ..." >&2
    exit 1
    ;;
esac
