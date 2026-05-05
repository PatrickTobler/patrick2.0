#!/bin/bash
# Read-only sandbox for the Scalable Capital `sc` CLI.
#
# This script sits at /usr/local/bin/sc on PATH. The real binary lives at
# /usr/local/lib/sc-real. The wrapper hard-blocks every known write
# subcommand and execs the real binary for everything else.
#
# Why a binary-level sandbox: skills/scalable/sc_query.sh is the documented
# entry point for the agent, but the agent's run_shell tool can call any
# binary on PATH. Without this wrapper, an agent could invoke
# `sc broker trade buy ...` directly. The wrapper closes that gap.
#
# Patrick's interactive use (`sc login`, `sc whoami`, `sc broker overview`,
# etc.) all pass through unchanged. If Patrick ever needs the unsanitized
# binary (e.g. to place a trade or run --help on a blocked subcommand), he
# can invoke /usr/local/lib/sc-real directly via railway ssh.

set -e
REAL_SC=/usr/local/lib/sc-real

if [ ! -x "$REAL_SC" ]; then
  echo "sc-sandbox: real binary missing at $REAL_SC" >&2
  exit 127
fi

# Walk args, skip flags, capture positional subcommands
positionals=()
for arg in "$@"; do
  case "$arg" in
    -*) ;;
    *) positionals+=("$arg") ;;
  esac
done

sub1="${positionals[0]:-}"
sub2="${positionals[1]:-}"
sub3="${positionals[2]:-}"

block() {
  echo "sc-sandbox: '$*' is BLOCKED. This deployment is read-only — use the Scalable app/web for writes." >&2
  exit 1
}

# Top-level write subcommand
[ "$sub1" = "logout" ] && block "sc logout"

# broker write subcommands
if [ "$sub1" = "broker" ]; then
  case "$sub2" in
    trade)
      block "sc broker trade ${sub3:-...}"
      ;;
    watchlist|price-alerts|savings-plans)
      [ "$sub3" = "add" ] || [ "$sub3" = "remove" ] && block "sc broker $sub2 $sub3"
      ;;
    context)
      [ "$sub3" = "select" ] && block "sc broker context select"
      ;;
  esac
fi

exec "$REAL_SC" "$@"
