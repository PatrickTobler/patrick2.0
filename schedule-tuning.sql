-- Schedule tuning, 2026-06-13 (supersedes yesterday's version — nothing was applied yet).
-- Run AFTER deploying the new build (needs migrations 1700000008000 + 1700000009000):
--   railway up --service patrick2-app --ci     (or npx @railway/cli up ...)
--   set -a; source .env; set +a; psql "$DATABASE_URL" -f schedule-tuning.sql

-- 1. EOD recap (#4): drop the Moltbook item — campaign deleted Jun 2, but this line
--    still spawns the Moltbook subagent every night.
update schedules
set prompt = replace(prompt, e'\n6. MOLTBOOK: If relevant, note karma change or engagement stats.\n', '')
where id = 4;

-- 2. Email triage (#12): full rewrite around notify_patrick (code-enforced dedup +
--    quiet hours). Urgent pings stay instant; notable becomes max one digest per 4h.
update schedules set prompt =
e'Email triage round. Goal: keep all three inboxes (primary, personal, masumi) tightly triaged; Patrick only hears about what matters.\n\nSTEPS:\n1. List unread emails across all accounts.\n2. Classify each as URGENT / NOTABLE / BULK:\n   - URGENT: security alerts, money at risk, replies Patrick must give within 24h, time-sensitive human questions directed at him. DigitalOcean monitoring emails are NOT urgent.\n   - NOTABLE: personal messages, collaborator emails, meeting requests, partnership inquiries.\n   - BULK: newsletters, promotions, automated notifications, GitHub bot noise, old calendar accepts, "Free Analysis" lead notifications.\n3. Mark BULK as read immediately. On personal account, mark all non-urgent as read.\n4. URGENT: call notify_patrick immediately — one call per email, item_key = the Gmail message id, urgency "urgent". Text: sender, subject, why it matters. One or two lines.\n5. NOTABLE: never notify per item. Collect into ONE digest and send via notify_patrick with item_key "email-notable-digest#<YYYY-MM-DD>-<HH>" and urgency "normal" — but ONLY if there are notable items AND your last digest (check the Recent Telegram pings block) is older than 4 hours. Otherwise hold them; a later round or the morning/EOD brief covers them. If there are new Free Analysis leads, include them as ONE line in the digest: "N new Free Analysis leads: domain1, domain2".\n6. If notify_patrick returns DUPLICATE or NEAR-DUPLICATE, that item is already handled — do not retry it, do not rephrase it, do not work around the refusal.\n7. Nothing urgent and no digest due: total silence.\n8. Do NOT modify any of Patrick''s manual labels (2, 4, 6, 7, 8, checkmarks). Only mark read/unread.'
where id = 12;

-- 3. Token report (#14): the tool now computes baseline anomalies itself — the prompt
--    just has to relay them.
update schedules set prompt =
e'[token-usage-report] This is an explicit daily reporting task — you MUST send the Telegram message. The usual "default to silence" rule does NOT apply here.\n\nCall get_token_usage with hours=24. Then send_telegram_message with a short, plain-voice summary:\n- Total tokens (rough in/out split) and estimated cost in USD for the last 24h.\n- A one-line per-model breakdown (model: tokens, $).\n- The tool output ends with an anomaly section (computed against each source''s 7-day baseline). If it flags anomalies, repeat them VERBATIM at the top of your message and say what you think is driving each one. If it says none, append "(normal)" to the total line.\n- If spend is ~0, just say so in one line.\nKeep it to a few lines. No preamble, no markdown headers.'
where id = 14;

-- 4. Slim tool profiles + model classes (columns exist only after deploy).
update schedules set tools = 'facts,gmail,telegram'                 where id = 12; -- triage, 96x/day
update schedules set tools = 'facts,thinking,vault,shell,telegram'  where id = 1;  -- masumi inbox, 48x/day
update schedules set tools = 'usage,telegram'                        where id = 14; -- token report
update schedules set model_class = 'reasoning' where id in (3, 10);  -- weekly consolidation + market analyst: judgment-heavy, 1x/week, worth the better model

-- 5. Weekly self-audit (Sunday 19:00) — the manual audit from Jun 12, automated.
insert into schedules (cron, prompt, timezone, tools, model_class)
select '0 19 * * 0',
e'[self-audit] Weekly behavior audit. Explicit reporting task — always send the report.\n\n1. Call get_token_usage with hours=168. Note the total, the top 3 sources, and the anomaly section.\n2. Call query_actions with outcome="errored", limit=30. Count errors by tool.\n3. Send ONE Telegram message:\n- Weekly spend total + whether it is trending up or down vs what the anomaly section implies.\n- Anomaly lines VERBATIM if any (especially sources that should not exist).\n- Error hotspots as "tool: count" lines (skip tools with 1 error).\n- One sentence: did notification volume look sane this week (check your own Recent Telegram pings block)?\nUnder 200 words, plain text.',
'Europe/Zurich', 'usage,actions,telegram', 'fast'
where not exists (select 1 from schedules where prompt like '[self-audit]%');

-- 6. RECOMMENDED CLEANUP (your call):
-- #7  rent reminder: reminded you ONCE (Apr 25), silently swallowed every Saturday
--     since. One-shots are now a real feature (one_shot column) — delete this and
--     recreate if still wanted: delete from schedules where id = 7;
-- #11 stale one-shot from May 6 with a yearly cron (fires again May 6, 2027):
--     delete from schedules where id = 11;
