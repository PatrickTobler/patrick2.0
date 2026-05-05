#!/bin/bash
# Scalable Broker — READ-ONLY wrapper around the `sc` CLI.
#
# This script is the ONLY interface the agent should use to talk to Scalable.
# It hard-blocks every mutating subcommand (trade buy/sell/cancel, watchlist
# add/remove, price-alerts add/remove, savings-plans add/remove, login/logout).
#
# Auth state lives on the volume (XDG_CONFIG_HOME=/data/home/.config). Patrick
# runs `sc login` once interactively via `railway ssh` to seed it.
#
# Output is structured JSON for every read command (--json flag). Caller is
# responsible for parsing.
set -e

if ! command -v sc >/dev/null 2>&1; then
  echo '{"error":"sc binary not found on PATH"}' >&2
  exit 1
fi

cmd="${1:-}"
shift || true

case "$cmd" in
  whoami)
    sc whoami "$@"
    ;;
  capabilities)
    sc capabilities --json "$@"
    ;;
  overview)
    sc broker overview --json "$@"
    ;;
  analytics)
    sc broker analytics --json "$@"
    ;;
  transactions)
    # Recent transactions / movements. Pass through any --since / --limit etc.
    sc broker transactions --json "$@"
    ;;
  transaction-details)
    TX_ID="${1:?Usage: sc_query.sh transaction-details <transactionId>}"
    sc broker transaction details --transaction-id "$TX_ID" --json
    ;;
  holdings)
    sc broker holdings --json "$@"
    ;;
  quote)
    ISIN="${1:?Usage: sc_query.sh quote <isin>}"
    sc broker quote --isin "$ISIN" --json
    ;;
  search)
    Q="${1:?Usage: sc_query.sh search <query>}"
    sc broker search "$Q" --json
    ;;
  security-news)
    ISIN="${1:?Usage: sc_query.sh security-news <isin> [locale]}"
    LOCALE="${2:-en_DE}"
    sc broker security-news --isin "$ISIN" --locale "$LOCALE" --json
    ;;
  watchlist)
    sc broker watchlist --json "$@"
    ;;
  price-alerts)
    sc broker price-alerts --active-only --json "$@"
    ;;
  savings-plans)
    sc broker savings-plans --json "$@"
    ;;
  context)
    sc broker context show --json
    ;;
  *)
    cat >&2 <<USAGE
Usage: $0 <subcommand> [args]

READ-ONLY subcommands:
  whoami                          Confirm session
  capabilities                    Machine-readable command surface
  overview                        Portfolio overview (balances, P&L)
  analytics                       Performance analytics
  transactions                    Recent movements / transactions
  transaction-details <id>        Full details for one transaction
  holdings                        Current positions
  quote <isin>                    Live quote for an ISIN
  search <query>                  Search instruments
  security-news <isin> [locale]   News for an ISIN (default locale en_DE)
  watchlist                       Read watchlist
  price-alerts                    List active price alerts
  savings-plans                   List savings plans
  context                         Show selected portfolio

WRITE subcommands (trade buy/sell/cancel, watchlist add/remove, alerts add/remove,
savings-plans add/remove, context select, login, logout) are intentionally NOT
exposed. Use the Scalable web/app for those.
USAGE
    exit 1
    ;;
esac
