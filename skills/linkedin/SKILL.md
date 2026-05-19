---
name: linkedin
description: Read Patrick's LinkedIn DMs, summarise unread, and send approved replies — all via the delegate_to_linkedin subagent (Browserbase + residential proxy, no API). Use for "check my LinkedIn DMs", "what's unread on LinkedIn", "reply to <name> on LinkedIn with X", or the periodic LinkedIn inbox cron.
---

# LinkedIn — DM read + reply via the `delegate_to_linkedin` subagent

## Why subagent

LinkedIn doesn't offer a usable DM API for individual accounts. The `delegate_to_linkedin` subagent drives linkedin.com through a stealth Browserbase Chromium session with a Swiss residential proxy and a persistent Browserbase context (cookies survive across runs). All DM tasks go through this delegation — never try to call HTTP endpoints or hit api.linkedin.com directly.

## Auth + 2FA

Patrick has 2FA on his LinkedIn account (authenticator app, TOTP). For the **first login** after a fresh deploy or after LinkedIn invalidates the cookie:

1. Tell the subagent to `log in` — it'll attempt with stored credentials.
2. It'll hit the 2FA challenge and return `Blocked — LinkedIn 2FA challenge. Ask Patrick for the current 6-digit code…`
3. **Ping Patrick on Telegram**: "LinkedIn needs the 2FA code." Wait for his reply.
4. Once he gives the code, re-invoke the subagent with task `log in with 2FA code 123456`.
5. On success, the subagent returns `Logged in successfully. Context saved.` Cookies persist, no more login required for weeks/months.

If you ever see `Blocked — LinkedIn 'unusual sign-in' verification` — that's a stronger challenge LinkedIn does for new IPs. Tell Patrick to log in once manually from his usual browser, then retry.

## Hard rules

- **NEVER auto-send a reply.** Even when the task says "draft a reply", a SEND only happens when Patrick has explicitly approved the exact text on Telegram. The same draft-before-send rule that applies to Gmail applies here.
- Never use the subagent for non-DM actions: don't post on the feed, don't react/like, don't send connection requests, don't follow anyone. DMs only.
- For periodic inbox checks (the cron), just READ and SUMMARISE — never preemptively draft + send.

## Patterns

**Periodic inbox check (the schedule)** — `delegate_to_linkedin(task="check my DM inbox, summarise the unread")`. Returns one line per unread thread. Surface to Telegram. Patrick replies "ignore" / "reply to X with Y" / "show me the thread with Z" on his own time.

**Read a specific thread** — `delegate_to_linkedin(task="open the thread with <name>, return the last 10 messages")`. Use when Patrick asks "what did <name> say on LinkedIn".

**Send an approved reply** — Patrick has just said *"reply to John with 'thanks, let's grab a call next week'"* in Telegram. Call `delegate_to_linkedin(task="send to John Smith: thanks, let's grab a call next week")`. Subagent navigates to the thread and sends. Returns `Sent to <name>: <preview>`.

**Draft a reply for Patrick to approve** — Patrick says *"what should I reply to Jane?"*. First call `delegate_to_linkedin(task="open the thread with Jane Doe, return the last 10 messages")`, then YOU compose a suggested reply in Patrick's voice and ask him "Want me to send: '<draft>'?". Only on his explicit yes do you call the subagent to send.

## When NOT to use

- Sending the same message to multiple people in quick succession — LinkedIn rate-limits and flags this as spammy. Mass-DM is a ban trigger.
- Reading random profiles / scraping — out of scope.
- LinkedIn posts / feed activity — out of scope.

## Errors

- `Blocked — LinkedIn 2FA challenge` → ping Patrick for the code, retry
- `Blocked — LinkedIn 'unusual sign-in' verification` → Patrick must log in manually from his usual browser first
- `Blocked — agent-browser failed` → typically transient; wait an hour and retry, or surface to Patrick
- Anything `Logged in successfully` after a `log in` task → cookies are saved, next runs are autonomous
