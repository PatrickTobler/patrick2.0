# Skill: chart
Source: /app/skills/chart/SKILL.md

---
name: chart
description: Generate and send charts to Patrick via Telegram. Uses QuickChart (quickchart.io) to render Chart.js configs as PNG images, then sends them via send_telegram_photo. Use when Patrick asks for a chart, graph, visualization, trend line, or "show me a chart of X".
---

# Chart generation via QuickChart

## How it works

QuickChart (quickchart.io) renders Chart.js configs as PNG images via a simple URL. No API key needed.

## Steps

1. **Get your data.** Fetch whatever data you need (WHOOP stats, Dune query, etc).
2. **Build a Chart.js config.** Standard Chart.js JSON — type, data (labels + datasets), options.
3. **JSON.stringify the config** and URL-encode it. Pass as the `c` query param.
4. **Send via send_telegram_photo** — pass the QuickChart URL as the `url` param. Add a short `caption`.

## URL format

```
https://quickchart.io/chart?c=ENCODED_CONFIG&w=800&h=400
```

- `w` / `h` = width/height in pixels (800x400 works well for Telegram)
- `c` = URL-encoded Chart.js config JSON
- Keep total URL under 1800 chars (Telegram limits)

## Example config (line chart)

```json
{
  "type": "line",
  "data": {
    "labels": ["05-07", "05-08", "05-09", "05-10"],
    "datasets": [
      {
        "label": "Sleep score %",
        "data": [75, 78, 61, 69],
        "borderColor": "#4e79a7",
        "yAxisID": "y",
        "spanGaps": true
      },
      {
        "label": "HRV ms",
        "data": [40.9, 50.7, 40.7, 38.2],
        "borderColor": "#59a14f",
        "yAxisID": "y",
        "spanGaps": true
      },
      {
        "label": "Strain",
        "data": [5.5, 5.9, 4.7, 4.5],
        "borderColor": "#f28e2b",
        "yAxisID": "y1",
        "spanGaps": true
      }
    ]
  },
  "options": {
    "scales": {
      "y": { "position": "left" },
      "y1": { "position": "right", "grid": { "drawOnChartArea": false } }
    }
  }
}
```

## Sending

ALWAYS use `send_telegram_photo` — never embed QuickChart URLs as text in `send_telegram_message`. The URL must be the image, not a clickable link.

```
send_telegram_photo(url="https://quickchart.io/chart?c=...", caption="7-day trend")
```

## URL length limits

If the config is too complex and the URL exceeds 1800 chars:
- Shorten dataset labels (e.g. "Sleep %" instead of "Sleep score %")
- Remove grid/styling options
- Reduce to fewer datasets
- As last resort, reduce chart width (w=600)

## Gotchas

- URL-encode the config properly. Spaces → %20, quotes → %22, etc.
- Always set `spanGaps: true` on datasets (handles null/missing days)
- For dual-axis charts, use `yAxisID: "y"` and `yAxisID: "y1"` with a right-side y1 axis
- Don't try to POST to QuickChart — the GET URL approach is simpler and works for all cron tasks
