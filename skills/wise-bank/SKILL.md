---
name: wise-bank
description: Query Patrick's Wise bank accounts via the Wise API. Use for "what's my balance", "show recent transactions", "what's the EUR/USD rate on Wise", "list my profiles", or any Wise account/transaction question. Auth via WISE_API_TOKEN env var (already set).
---

# Wise Bank — Account & Transaction Queries

## Auth
`WISE_API_TOKEN` env var holds Patrick's personal Wise API token. Send as `Authorization: Bearer $WISE_API_TOKEN` to `https://api.wise.com`. Do NOT print the token.

## Profiles (use as `<profileId>` below)
| Profile | ID | Type |
|---------|-----|------|
| Patrick Tobler (personal) | `22509074` | PERSONAL |
| utxo AG | `49028278` | BUSINESS |
| FI Finest Investments GmbH | `58335400` | BUSINESS |

## When to use
- Account balances across currencies
- Recent transactions / activities
- Exchange rate lookups
- Transfer history
- Bank account details
- Anything about Wise account state

## Helper script
A bash helper is bundled at `skills/wise-bank/wise_query.sh`. Reads `WISE_API_TOKEN` from env. All output is raw JSON.

```bash
./skills/wise-bank/wise_query.sh profiles                       # list profiles
./skills/wise-bank/wise_query.sh balances <profileId>           # balances by currency
./skills/wise-bank/wise_query.sh activities <profileId> [size]  # recent activities (default 10)
./skills/wise-bank/wise_query.sh rate <source> <target>         # exchange rate, e.g. EUR USD
./skills/wise-bank/wise_query.sh accounts <profileId>           # bank account details
```

## Direct API calls

```bash
# All profiles
curl -s -H "Authorization: Bearer $WISE_API_TOKEN" https://api.wise.com/v2/profiles

# Balances for a profile
curl -s -H "Authorization: Bearer $WISE_API_TOKEN" \
  "https://api.wise.com/v4/profiles/<profileId>/balances?types=STANDARD,SAVINGS"

# Recent activities
curl -s -H "Authorization: Bearer $WISE_API_TOKEN" \
  "https://api.wise.com/v1/profiles/<profileId>/activities?size=20"

# Exchange rate
curl -s -H "Authorization: Bearer $WISE_API_TOKEN" \
  "https://api.wise.com/v1/rates?source=EUR&target=USD"
```

## Patterns

**"What's my EUR balance across accounts?"**
1. List profiles
2. For each, call balances, filter currency=EUR, sum

**"Recent transactions on utxo AG"**
- `activities 49028278 25` → parse the activity feed

**"What's the cost of converting 1000 CHF to USD?"**
- `rate CHF USD` → multiply, then mention Wise's typical fee (~0.4-0.5%)
