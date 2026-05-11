---
name: whoop
description: Pull Patrick's WHOOP daily stats (sleep, HRV, RHR, recovery, strain, sleep stages, workouts) via the official WHOOP Developer API. Use for "what's my recovery", "how did I sleep", "HRV trend", "yesterday's strain", the daily WHOOP cron, or any health-data question.
---

# WHOOP — daily stats via the official Developer API

## How auth works

Three env vars on Railway, configured via OAuth (no raw user password ever stored):
- `WHOOP_CLIENT_ID` + `WHOOP_CLIENT_SECRET` — registered app at developer.whoop.com
- `WHOOP_REFRESH_TOKEN` — long-lived refresh token from the one-time consent flow

The bot auto-refreshes the access token in memory; nothing for you to do at runtime.

If `WHOOP_REFRESH_TOKEN` ever expires or gets revoked, tell Patrick — he re-runs `npx tsx scripts/whoop-oauth.ts` locally, gets a fresh refresh token, sets it on Railway.

## Tool

Use the agent tool **`get_whoop_stats`** — it returns a clean structured summary for one date:

```
get_whoop_stats(date="YYYY-MM-DD")
```

The date is treated as a local-day window (00:00:00–23:59:59 UTC of that date as the query range; WHOOP returns records overlapping that window). Use `current_time` to get today's Zurich date first.

## JSON shape (in tool result `details`)

```
{
  date: "2026-05-11",
  recovery: { score, hrv_ms, rhr_bpm, spo2_pct, skin_temp_c },
  sleep:    { score_pct, efficiency_pct, consistency_pct, performance_pct,
              respiratory_rate, stages_min:{rem,deep,light,awake},
              duration_min, needed_min, start, end },
  cycle:    { strain, avg_hr, max_hr, kilojoule, start, end },
  workouts: [{ sport_id, strain, start, end, duration_min }, ...]
}
```

Any field can be `null` when WHOOP hasn't scored the day yet (common mid-morning before Patrick syncs).

## Hard "do not"s

- **Never** try to fetch `app-internal.whoop.com/*` — that interface is dead from Railway (Cloudflare WAF blocks data-center IPs)
- **Never** invoke a local `whoop` binary — there isn't one in the container anymore
- **Never** ask Patrick for his WHOOP email/password — the OAuth refresh token handles auth

## Patterns

**Morning recovery check** — call `get_whoop_stats` with today's Zurich date, read recovery.score, sleep.score_pct, sleep.hrv_ms, sleep.rhr_bpm.

**Yesterday's strain + workouts** — call with yesterday's Zurich date, read cycle.strain and workouts[].

**7-day chart** (schedule 8) — loop the last 7 Zurich dates, call `get_whoop_stats` per day, plot sleep.score_pct / sleep.hrv_ms / cycle.strain via QuickChart.

## Errors the tool surfaces

- `not_configured` → one of the three env vars missing; tell Patrick
- `WHOOP API 401 ...` → refresh token expired/revoked; tell Patrick to re-run the OAuth helper
- `WHOOP API 429 ...` → rate limit (rare); retry once with backoff or skip the day
- Any other → report verbatim, don't retry silently
