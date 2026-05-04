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
  all-activities)
    PROFILE_ID="${2:?Usage: wise_query.sh all-activities <profileId> [size]}"
    SIZE="${3:-100}"
    node -e "
const https = require('https');
const fs = require('fs');
const token = process.env.WISE_API_TOKEN;
const profileId = '$PROFILE_ID';
const size = $SIZE;

async function fetchPage(cursor) {
  let url = 'https://api.wise.com/v1/profiles/' + profileId + '/activities?size=' + size;
  if (cursor) url += '&nextCursor=' + encodeURIComponent(cursor);
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: 'Bearer ' + token } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

(async () => {
  let all = [];
  let cursor = null;
  for (let i = 0; i < 20; i++) {
    const resp = await fetchPage(cursor);
    const acts = resp.activities || [];
    all.push(...acts);
    if (!resp.cursor || resp.cursor === cursor || acts.length < size) break;
    cursor = resp.cursor;
  }
  process.stdout.write(JSON.stringify(all));
})();
"
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
    echo "Usage: $0 {profiles|balances|activities|all-activities|rate|accounts} ..." >&2
    exit 1
    ;;
esac
