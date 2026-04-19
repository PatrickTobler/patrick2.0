---
name: gtm-cli
description: Manage Google Tag Manager (tags/triggers/variables/publishing) and query Meta Ads (pixel events, campaign performance, leads) for Patrick's Serviceplan-Agents container. Use for "check GTM tag X", "what's firing", "how is the Meta pixel performing", "publish a new GTM version", or Meta Ads analytics.
---

# Google Tag Manager & Meta Ads

## When to use
- GTM: list/create/edit tags, triggers, variables, check container config, publish versions
- Meta Ads: check pixel events, campaign performance, ad sets, creatives, leads

## GTM CLI: `gtm` (`@owntag/gtm-cli`)

Auth is OAuth-bound to `patrick@masumi.network`. **Important:** the `GOOGLE_APPLICATION_CREDENTIALS` env var (set for Calendar/Gmail OAuth) overrides GTM's OAuth login. Always unset it for the call:

```bash
unset GOOGLE_APPLICATION_CREDENTIALS && gtm <command>
```

### Configured defaults (already loaded in `gtm config`)
- Account ID: `6342118918` (Serviceplan-Agents)
- Container ID: `245128484` (www.serviceplan-agents.com / GTM-WFRT3NVF)
- Workspace ID: `17`

### Quick reference
```bash
gtm tags list                            # all tags
gtm triggers list                        # all triggers
gtm variables list                       # all variables
gtm tags get --tag-id <id> -o json       # tag details
gtm versions create --name 'v1.0'        # create version
gtm versions publish --version-id <id>   # publish
```

### Key tags currently configured
| ID | Name | Type | Fires on |
|----|------|------|----------|
| 4 | Google Tag G-NBE53WQ3QE | googtag | All Pages |
| 13 | Meta Pixel (841172315602323) | html | All Pages |
| 5 | GA4 - Free Analysis Request | gaawe | free_analysis_request |
| 12 | GA4 - Demo Request | gaawe | demo_request |
| 14 | Meta Pixel - Free Analysis | html | free_analysis_request |
| 15 | Meta Pixel - Demo Request | html | demo_request |

## Meta Ads API

Auth: `META_ADS_TOKEN` env var (already set). Pixel: `META_PIXEL_ID` env var. Ad account: `META_AD_ACCOUNT_ID` env var.

### Check pixel events (last 24h)
```bash
curl -s "https://graph.facebook.com/v21.0/$META_PIXEL_ID/stats?aggregation=event&access_token=$META_ADS_TOKEN"
```

### Campaign performance
```bash
curl -s "https://graph.facebook.com/v21.0/act_$META_AD_ACCOUNT_ID/insights?fields=campaign_name,spend,impressions,clicks,actions&date_preset=last_7d&level=campaign&access_token=$META_ADS_TOKEN"
```

### Ad sets in a campaign
```bash
curl -s "https://graph.facebook.com/v21.0/<campaign_id>/adsets?fields=name,status,daily_budget,targeting&access_token=$META_ADS_TOKEN"
```

### Leads from a lead-gen form
```bash
curl -s "https://graph.facebook.com/v21.0/<form_id>/leads?access_token=$META_ADS_TOKEN"
```

## Common workflow patterns

**"Is X event firing?"**
1. `unset GOOGLE_APPLICATION_CREDENTIALS && gtm tags list` → find tag id
2. `gtm tags get --tag-id <id> -o json` → confirm trigger config
3. Cross-check actual fires via Meta pixel stats endpoint

**"Add a new conversion event"**
1. Create the GA4/Meta pixel tag with appropriate trigger
2. `gtm versions create --name 'add-conversion-X'`
3. `gtm versions publish --version-id <id>`

**"How are we doing this week?"**
- Pull the campaign insights endpoint with `date_preset=last_7d`
- Summarize spend, impressions, conversions
