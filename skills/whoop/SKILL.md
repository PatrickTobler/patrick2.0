---
name: whoop
description: Pull Patrick's WHOOP daily stats (sleep, HRV, RHR, recovery, strain, steps, weight, workouts, healthspan) via the local `whoop` CLI. Use for "what's my WHOOP recovery", "how did I sleep", "HRV trend", "yesterday's strain", the daily WHOOP cron, or any health-data question.
---

# WHOOP — daily stats via the `whoop` CLI

## Auth

`WHOOP_EMAIL` and `WHOOP_PASSWORD` env vars hold Patrick's WHOOP credentials. The CLI re-auths against `api.prod.whoop.com` (Cognito) on every invocation — no token cache to worry about. If a call fails with an auth error, ask Patrick to verify the credentials are set in Railway env.

## The binary

`/usr/local/bin/whoop` — single static binary, no runtime deps. Run via the `run_shell` tool.

## Commands

```bash
whoop stats                          # today (Zurich), default human-readable text
whoop stats --json                   # today as structured JSON
whoop stats --date 2026-05-10 --json # specific date as JSON (UTC date string)
```

**Use `--json` for any agentic reasoning** — the text mode is human-formatted and lossy.

Default date is "today in the container's local time" which on Railway is **UTC**, not Zurich. For Patrick-facing reports, pass `--date` explicitly using `current_time` to get the Europe/Zurich date.

## JSON shape (top-level keys)

- `date` — YYYY-MM-DD requested
- `day.{start, end}` — ISO timestamps for the WHOOP day window
- `sleep` — `{score, hours, hoursVsNeeded, hoursNeeded, hours30dAvg, efficiency, efficiency30dAvg, consistency, consistency30dAvg, rhr:{value,avg30d}, hrv:{value,avg30d}, bedTime, wakeTime, stages:{rem,deep,light}}`
- `steps` — `{value, avg30d}`
- `weight` — `{value, avg30d}` (in lbs/kg as WHOOP returns)
- `vo2Max` — `{value, avg30d}` (when available)
- `workouts` — array of `{name, start, end, duration}`
- `healthspan` — `{date, whoopAge, previous:{whoopAge, paceOfAging}, paceOfAging, yearsDifference, nextUpdate}`

Any field can be `null` if WHOOP hasn't computed it yet for that day (common for "today" mid-day).

## Patterns

**Morning recovery check**
```bash
whoop stats --json
```
Read `sleep.hrv.value` vs `sleep.hrv.avg30d`, `sleep.rhr.value` vs `sleep.rhr.avg30d`, `sleep.score`, sleep hours vs needed.

**Yesterday's strain + workout**
```bash
DATE=$(date -d "yesterday" +%Y-%m-%d)
whoop stats --date $DATE --json
```
(For "yesterday in Zurich" pass that exact date from `current_time`.)

**7-day trend chart** (daily WHOOP cron, schedule 8)
Loop over the last 7 dates (Zurich), call `whoop stats --date YYYY-MM-DD --json` per day, extract `sleep.score`, `sleep.hrv.value`, plus `day.start` for x-axis labels, hand to QuickChart.

## When NOT to use

- Real-time / live data — WHOOP API is "yesterday's recovery available this morning" sort of cadence; today's recovery only appears once Patrick wakes up
- Long historical pulls — the CLI is one-day-at-a-time, so don't loop 90 days; if Patrick wants long history, escalate

## Errors

- `Missing WHOOP_EMAIL` / `Missing WHOOP_PASSWORD` → env vars not set on Railway; tell Patrick
- `Login failed: 401` → wrong credentials; tell Patrick
- `Login failed: 5xx` → WHOOP outage; retry once, otherwise note "WHOOP unreachable" and continue
- All other failures → report verbatim, don't retry silently
