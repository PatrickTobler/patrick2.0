---
name: scalable
description: READ-ONLY query of Patrick's Scalable Capital broker account (portfolio, holdings, transactions, quotes). Use for "what's in my Scalable portfolio", "Scalable movements last week", "what's my P&L on <ticker>", or anything about Scalable account state. Trading is NEVER exposed — this is read-only by design.
---

# Scalable Broker — READ-ONLY queries

## Hard rule: read-only

Patrick uses the Scalable broker. This skill exposes ONLY read commands (overview, transactions, holdings, quotes). Trading, watchlist edits, savings-plan edits, and login/logout are **not** available through this skill. If Patrick asks you to place a trade, tell him to use the Scalable web app — never try to invoke `sc broker trade` directly.

Everything goes through the wrapper at `skills/scalable/sc_query.sh`. Never call the bare `sc` binary — the wrapper is the guardrail that keeps you read-only.

## Auth

Auth state is seeded once interactively by Patrick via `sc login` over `railway ssh`. Tokens live on the Railway volume at `/data/home/.config/sc/`, so they survive deploys. If queries start failing with auth errors, ask Patrick to re-run `sc login`.

## Helper script

`skills/scalable/sc_query.sh` — bash wrapper. All output is JSON.

```bash
./skills/scalable/sc_query.sh whoami                      # confirm session
./skills/scalable/sc_query.sh overview                    # portfolio overview (balances, P&L)
./skills/scalable/sc_query.sh analytics                   # performance analytics
./skills/scalable/sc_query.sh transactions                # recent movements
./skills/scalable/sc_query.sh transaction-details <txId>  # one transaction in full
./skills/scalable/sc_query.sh holdings                    # current positions
./skills/scalable/sc_query.sh quote <isin>                # live quote (ISIN, e.g. US0378331005)
./skills/scalable/sc_query.sh search "<query>"            # search instruments by name/ticker
./skills/scalable/sc_query.sh security-news <isin> [locale]
./skills/scalable/sc_query.sh watchlist                   # read watchlist
./skills/scalable/sc_query.sh price-alerts                # active price alerts
./skills/scalable/sc_query.sh savings-plans               # list savings plans
./skills/scalable/sc_query.sh context                     # which portfolio is selected
```

Pass-through flags (e.g. `--limit`, `--since`) work for the underlying `sc` command, e.g.:

```bash
./skills/scalable/sc_query.sh transactions --limit 50
```

## Patterns

**"Scalable movements / transactions last week"** (morning brief)
```bash
./skills/scalable/sc_query.sh transactions
```
Filter the resulting JSON by date (the `executed_at` / `booked_at` field) — last 7 days, summarize by type (buy / sell / dividend / fee).

**"What's my Scalable P&L?"**
```bash
./skills/scalable/sc_query.sh overview
./skills/scalable/sc_query.sh analytics
```

**"How much Apple do I hold?"**
```bash
./skills/scalable/sc_query.sh holdings
```
Filter the JSON by ISIN/ticker.

**"What's <ISIN> trading at?"**
```bash
./skills/scalable/sc_query.sh quote <isin>
```

## When to use

- Morning brief: include a Scalable section alongside Wise (movements + holdings delta since yesterday)
- Patrick asks about portfolio value, P&L, specific positions
- Quote / news lookup before he asks about a ticker
- Verify a transaction Patrick mentions ("did that 500€ Apple buy go through?")

## When NOT to use

- Anything involving placing, modifying, or canceling a trade → tell Patrick to use the Scalable app
- Adding/removing a watchlist entry, price alert, or savings plan → tell Patrick to use the app
- If `whoami` fails with an auth error → tell Patrick to re-run `sc login`; do not try to recover
