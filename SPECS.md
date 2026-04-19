# patrick2.0 — Specs

A personal assistant agent built to feel like a clone of Patrick. Reads his life, drafts on his behalf, surfaces what matters, and grows a model of how he thinks over time.

---

## North Star

**Success means:** Patrick uses it daily without forcing himself, and replies/notes it produces sound like him. Not "an AI that helps Patrick" — a digital twin that absorbs his thinking and acts as an extension of him.

---

## Architecture (one-page view)

```
                   Telegram (primary chat + nudges)
                              |
                              v
   +------------------------------------------------------+
   |               patrick2.0 service (Railway)           |
   |                                                      |
   |   pi-agent-core (TypeScript)                         |
   |     - LLM router via pi-ai (OpenRouter backend)      |
   |     - AgentTool registry (native + MCP-wrapped)      |
   |     - Skills loader (pi native, ~/.claude/skills)    |
   |     - Slash command registry                         |
   |     - Conversation loop with hooks                   |
   |                                                      |
   |   Memory layer (Postgres + pgvector)                 |
   |     - facts | history | notes | actions | thinking   |
   |                                                      |
   |   Tool plugins (AgentTool wrappers)                  |
   |     - gmail | gcal | todos | obsidian                |
   |     - telegram-personal | whatsapp | slack           |
   |     - MCP bridge -> any MCP server (stdio/http)      |
   |                                                      |
   |   Scheduler (cron + event watchers)                  |
   |     - polling jobs -> nudge engine -> Telegram       |
   +------------------------------------------------------+
                              |
                              v
                  Postgres (Railway) + S3-compatible blob
```

**Stack**
- Runtime: Node.js + TypeScript
- Agent framework: `@mariozechner/pi-agent-core` + `@mariozechner/pi-ai` (badlogic/pi-mono)
- LLM: OpenRouter (via pi-ai's OpenAI-compatible provider, base URL override)
- Skills: pi-mono's native Agent Skills loader (progressive disclosure — descriptions in prompt, full SKILL.md loaded on demand). Reuses Patrick's existing `~/.claude/skills/` directory.
- MCP: pi-mono has no native MCP client yet, so we wrap MCP servers as `AgentTool` instances via `@modelcontextprotocol/sdk` and register them at boot.
- Bot: `node-telegram-bot-api` (or grammy)
- DB: Postgres with `pgvector` for semantic memory recall
- Deploy: Railway (one service + one Postgres add-on)
- Auth: API keys / app passwords stored as Railway env vars
- Observability: structured JSON logs to stdout; Railway log drain

**Pi-first principle**
Use pi-mono primitives wherever they exist before reaching for alternatives. Concretely: `Agent` class for the loop, `AgentTool` for tools, pi-ai providers for LLM calls, `transformContext` hook for memory injection, `beforeToolCall`/`afterToolCall` hooks for action logging and approval gates, native skills loader for skills, slash-command registry for `/think`, `/pause`, `/resume`, `/skill:*`. Don't write a custom agent loop, custom tool runtime, or custom skill loader.

**Hard constraints**
- Single user (Patrick). No multi-tenant code paths.
- Direct & terse tone everywhere — bot replies, nudges, summaries.
- Always draft, never auto-send replies on personal channels (Telegram/WhatsApp/Slack). Approve-then-send.
- Outbound message rate cap: max 1 nudge per 15 min unless flagged urgent.

---

## Feature catalog

Each feature is a vertical slice: it ships, it gets tested, then we move to the next. Tests are concrete and runnable — no "it should feel right" criteria.

Test types used below:
- **Unit** — isolated function, mocked deps
- **Integration** — real DB, real LLM (or recorded fixture), mocked external APIs
- **E2E** — real Telegram test bot, real Gmail test account, real Postgres
- **Manual eval** — Patrick reads N samples and judges (used for "sounds like me" tests)

---

### F0 — Foundation

#### F0.1 Project scaffold
TypeScript monorepo-style single package. ESM. Strict TS. `npm run check` passes (typecheck + lint).

**Tests**
- CI: `npm run check` exits 0
- CI: `npm test` runs and passes (even if 0 tests initially)

#### F0.2 LLM router via pi-ai → OpenRouter
Wrap `pi-ai`'s OpenAI-compatible provider with `baseURL=https://openrouter.ai/api/v1`. Config selects model per task class: `reasoning`, `fast`, `cheap`. Default mapping: `reasoning=anthropic/claude-opus-4`, `fast=anthropic/claude-haiku-4.5`, `cheap=google/gemini-2.5-flash`.

**Tests**
- Unit: `chooseModel('reasoning')` returns the configured model id
- Integration: real OpenRouter call returns a non-empty string for "reply with the word PONG"
- Integration: model fallback — when the primary 5xx's, the router retries on the configured fallback

#### F0.3 Postgres + migrations
Postgres connection via `pg`. Migrations via `node-pg-migrate`. Schema for `messages`, `memory_facts`, `memory_thinking`, `memory_actions`, `notes`.

**Tests**
- Integration: migrations run cleanly against a fresh DB (CI uses ephemeral Postgres)
- Integration: down-migrations leave no orphan tables
- Unit: connection pool reuses connections (no leak after 1000 calls)

#### F0.4 Telegram bot transport
Single bot, hardcoded ALLOWED_CHAT_ID = Patrick's chat id (rejects any other sender). Long-polling in dev, webhook in Railway.

**Tests**
- Unit: messages from non-allowlisted chat id are dropped (no LLM call, no DB write)
- E2E: `/start` from Patrick → bot replies "ready"
- E2E: arbitrary text from Patrick → bot calls LLM and echoes a reply

#### F0.5 Conversation loop
Each inbound Telegram message → load last N turns from `messages` → call agent loop → stream reply back via Telegram (edit-in-place as tokens arrive). Persist both turns.

**Tests**
- Integration: 3 sequential messages produce a coherent thread (LLM sees prior turns)
- Integration: message history truncates at token budget (configurable, default 32k)
- E2E: streaming visibly updates the Telegram message at least 3 times for a long reply

---

### F1 — Memory (the "clone of me" engine)

This is the core IP. Everything else is plumbing around this.

#### F1.1 Fact memory
Patrick says "remember that X" or the agent infers a stable fact ("Patrick prefers async over meetings"). Stored as `(id, text, embedding, source, created_at, confidence)`. Semantic recall via pgvector.

**Tests**
- Unit: `extractFacts(message)` extracts 0..N facts from a message; deterministic on a fixture set
- Integration: `recall("how does Patrick feel about meetings?")` returns the meetings fact in top-3 results
- Integration: duplicate facts get merged (cosine similarity > 0.95 → upsert, bump confidence)
- Manual eval: after 1 week of use, Patrick reviews stored facts; ≥80% are accurate and useful

#### F1.2 Thinking dumps
Patrick can fire off raw thoughts ("I'm starting to think the right play on Demosthenes is X because Y"). Stored as `memory_thinking` with full text + embedding + topic tags auto-extracted. Different from facts — these are evolving positions, not stable truths.

**Tests**
- Unit: `/think <text>` command routes to thinking store, not fact store
- Integration: ask "what have I been thinking about Demosthenes?" → returns last 5 thinking entries on that topic, newest first
- Integration: thinking entries are NEVER auto-applied as facts (separate table, separate recall path)
- Manual eval: after 1 month, ask the bot to summarize Patrick's evolving views on a topic; output reads as a believable position summary

#### F1.3 Conversation history search
Every message in/out is stored. Semantic + keyword search across all history.

**Tests**
- Integration: store 1000 fixture messages; search for a phrase only present in 1 message returns that message in top-3
- Integration: recall by date range works ("what did I tell you last Tuesday?")
- Performance: search over 100k messages returns in <500ms p95

#### F1.4 Action history
Every tool call (sent email draft, scheduled event, written note) is logged with input, output, outcome, and Patrick's eventual approval/rejection.

**Tests**
- Integration: a draft email logged → Patrick approves → action marked `outcome=accepted`
- Integration: query "what actions did I reject this week?" returns rejected actions
- Unit: action logger never blocks the main loop (writes are async, failures don't fail the request)

#### F1.5 Memory-injected prompts
Every LLM call gets a system prompt that includes top-K relevant facts + recent thinking on the current topic + Patrick's static profile. K is budget-bounded.

**Tests**
- Integration: the assembled prompt for "draft a reply to this email about meetings" includes the meetings-preference fact
- Integration: prompt assembly stays under configured token budget even when 1000+ facts exist
- Manual eval: 20 sample replies — Patrick rates "does this sound like me?" on 1-5; target avg ≥4 by month 2

---

### F2 — Daily life integrations

Each integration ships as: read tool + (where applicable) draft tool + watcher (for nudges). API keys stored in Railway env.

#### F2.1 Gmail
**Tools:** `gmail.list_unread`, `gmail.read(id)`, `gmail.search(query)`, `gmail.draft_reply(thread_id, body)`, `gmail.send_draft(draft_id)`.
Auth: Gmail app password + IMAP/SMTP, OR Gmail API key with limited scope. Choose IMAP/SMTP for simplicity per Patrick's "API keys" preference.

**Tests**
- Unit: parser extracts subject/from/snippet from raw IMAP message
- Integration: against a test inbox — list 10 unread, read one, draft a reply (do not send)
- E2E: Patrick says "draft a reply to the latest email from X" → bot returns draft for approval → Patrick says "send" → email sent

#### F2.2 Google Calendar
**Tools:** `gcal.today`, `gcal.upcoming(hours)`, `gcal.find_slot(duration, date_range)`, `gcal.create_event(title, start, end, attendees)`.
Auth: Google service account or app-specific token.

**Tests**
- Integration: against a test calendar — list today's events, find a free 30-min slot tomorrow, create an event
- Integration: `find_slot` respects working hours (configurable per Patrick's profile)
- E2E: "Book 30 min with Alex tomorrow afternoon" → event created on test calendar with invite

#### F2.3 Todos
**Tools:** `todo.add(text, due?)`, `todo.list(filter?)`, `todo.complete(id)`, `todo.snooze(id, until)`.
Backend choice: native (own table) for v1 — adding Todoist/Things later is a swap-out. Decision: native.

**Tests**
- Unit: due-date parser handles "tomorrow", "next Monday", "in 3 hours", absolute dates
- Integration: add a todo, list it, complete it, list again — count decreases by 1
- E2E: "remind me to call mom tomorrow at 6pm" → todo created with correct due time → at 6pm tomorrow, Telegram nudge fires

#### F2.4 Obsidian
**Tools:** exposed via the F6.2 MCP bridge — `mcp__obsidian__read_note`, `mcp__obsidian__write_note`, `mcp__obsidian__search_notes`, etc. No custom Obsidian client; we wire the existing Obsidian MCP server Patrick already has installed.

**Tests**
- Integration: bot boot launches the Obsidian MCP server; tools appear in the registry
- Integration: search returns same results as direct MCP calls for a known query
- E2E: "write a note about today's call with X" → note created in `Claude-Code/Calls/` (or a configurable folder)

Note: this slice depends on F6.2 (MCP bridge) being landed first, OR a temporary direct integration that gets replaced when F6.2 ships.

---

### F3 — Personal channel ingestion (read + draft)

Patrick's own Telegram, WhatsApp, Slack — agent reads incoming messages, drafts replies, never auto-sends.

#### F3.1 Telegram personal
Auth: Telegram MTProto via `gramjs` (user account, not bot). Stores session string in env.
**Tools:** `tg.list_dms(unread_only)`, `tg.read_chat(id)`, `tg.draft_reply(chat_id, text)`.
**Watcher:** poll every 60s; new DMs from non-bot non-channel sources → flag for review.

**Tests**
- Integration: against a test Telegram account — read last 10 chats, get correct unread count
- Integration: drafts are saved locally, never sent, until Patrick approves via the patrick2.0 bot
- E2E: someone messages Patrick's personal Telegram → patrick2.0 bot pings him with summary + draft → Patrick says "send" → message sent from Patrick's account

#### F3.2 WhatsApp (read-only)
Pairs with Patrick's primary WhatsApp account via WhatsApp Web (`whatsapp-web.js`, QR scan once, session persisted). **Read-only — no drafting, no sending.** Bot summarizes and flags incoming messages so Patrick can decide what to act on; he replies himself in the WhatsApp app.
**Tools:** `wa.list_chats(unread_only)`, `wa.read_chat(id)`, `wa.summarize_unread()`.
**Watcher:** poll every 5 min; new DMs from people (not groups, not broadcasts) get flagged. Group messages summarized in the morning briefing only.

**Tests**
- Integration: paired session reads chat list correctly
- Code-level guard: WhatsApp tool module exposes no `send`/`reply`/`sendMessage` symbol; lint rule fails the build if one is added
- Unit: `wa.summarize_unread()` produces a short Telegram-friendly summary (≤500 chars) for a fixture inbox
- E2E: send a test WhatsApp message to Patrick → patrick2.0 bot pings him with sender + summary within 6 min, and never offers a Send button

#### F3.3 Slack
Auth: Slack user token (xoxp) with `channels:history`, `chat:write`, `im:history` scopes. Patrick generates manually via Slack app.
**Tools:** `slack.list_dms`, `slack.read_channel(id)`, `slack.draft_reply(channel, text)`.

**Tests**
- Integration: list DMs returns correct conversations
- Integration: draft → approve → send round-trip works on a test workspace
- E2E: someone messages Patrick on Slack → patrick2.0 bot pings → approve → reply sent

---

### F4 — Proactivity (event-driven nudges)

A scheduler runs jobs that watch state and fire nudges to Telegram when rules match. All nudges go through a single `notify(level, message)` chokepoint with rate limiting.

#### F4.1 Scheduler
Cron-style with `node-cron`, plus ad-hoc one-shots via DB-backed job queue.

**Tests**
- Unit: cron parser accepts standard expressions
- Integration: a 1-min job fires N times in N+1 minutes (within ±5s tolerance)
- Integration: jobs survive a service restart (loaded from DB on boot)

#### F4.2 Morning briefing (08:00 local)
Telegram message at 08:00 with: today's calendar, top 3 unread emails (importance-ranked), open todos due today, anything flagged from F3 channels overnight.

**Tests**
- Integration: trigger the job manually with fixture data → produces a single, well-formatted message
- Integration: importance ranker is deterministic on fixture inputs
- Manual eval: 7 consecutive morning briefings — Patrick rates each "useful / noise"; target ≥5/7 useful

#### F4.3 Meeting prep (T-10 min)
10 minutes before each calendar event with attendees, send: attendee names, last conversation context (from Gmail/Slack/Telegram history with that person), any related Obsidian notes, prepared talking points.

**Tests**
- Integration: fixture meeting with attendee X → prep includes last email thread with X
- Integration: meetings without attendees (focus blocks) skip the nudge
- E2E: real test calendar event → nudge arrives between T-11 and T-9

#### F4.4 Urgent email watcher
Poll Gmail every 2 min. Classify new emails via fast LLM. If `urgency=high`, nudge immediately with summary + draft reply.

**Tests**
- Integration: classifier on labeled fixture set hits ≥80% precision on "urgent" class
- Integration: rate limit holds — 5 urgent emails in 1 min produce 1 nudge with all 5 batched, not 5 nudges
- E2E: send a test email matching urgent criteria → nudge within 3 min

#### F4.5 End-of-day recap (21:00 local)
Summary of: meetings done, todos completed/deferred, decisions made, key things Patrick said today (mined from his messages to the bot). Stored as a daily journal entry in Obsidian under `Daily/YYYY-MM-DD.md`.

**Tests**
- Integration: trigger manually → recap is non-empty and references today's actions
- Integration: writes to Obsidian at the configured path
- Manual eval: after 14 days, Patrick rates "does this capture today?" target ≥10/14 useful

---

### F5 — Approval & control

Every action that affects the outside world (sending a message, creating an event, sending an email) requires explicit approval from Patrick via Telegram inline buttons.

#### F5.1 Approval flow
Bot posts: `Draft: "..." [Send] [Edit] [Cancel]`. Tap → action executes or routes to an edit conversation.

**Tests**
- Integration: each button maps to the right handler; no path bypasses approval
- Unit: pending actions expire after 24h (won't fire stale approvals)
- E2E: full approve→send round-trip on Gmail and Telegram personal

#### F5.2 Quiet hours
Patrick configures hours (default 22:00–07:00). During quiet hours, only `level=critical` nudges go through. Everything else queues until morning.

**Tests**
- Unit: rate limiter respects quiet hours
- Integration: 10 non-critical nudges queued at 23:00 deliver as 1 batched message at 07:00
- Integration: a `critical` nudge at 02:00 delivers immediately

#### F5.3 Kill switch
`/pause` command stops all proactive nudges and all background polling until `/resume`. State persisted to DB.

**Tests**
- E2E: `/pause` → no nudges fire for 30 min → `/resume` → nudges resume
- Integration: pause survives a service restart

---

### F6 — Skills & MCP servers

Patrick already invests in Claude Code skills and MCP servers (Obsidian, Google Docs, GitHub, Railway, Sokosumi, Wise, etc.). patrick2.0 should reuse them, not reinvent them.

#### F6.1 Skills loader (pi-native)
Use pi-mono's built-in skills system. Configure pi to load from:
- `~/.pi/agent/skills/` (pi-native, future skills)
- `~/.claude/skills/` (Patrick's existing skills — obvious-communication, ga4-analytics, wise-bank, etc.)
- `./.pi/skills/` (project-local skills bundled with patrick2.0)

Skills are surfaced to the LLM via progressive disclosure (descriptions in system prompt, full SKILL.md loaded on demand). Slash commands (`/skill:obvious-communication`, `/skill:ga4-analytics`) are wired into the Telegram bot — Patrick can invoke any skill by typing `/skill:<name> <args>` in chat.

**Tests**
- Unit: skill discovery scans configured directories and returns `{name, description}` for every valid SKILL.md
- Unit: invalid skills (bad frontmatter, name mismatch) emit warnings but don't crash boot
- Integration: bot boot logs the count of loaded skills; Patrick's existing Claude Code skills appear in the list
- Integration: `/skill:obvious-communication` from Telegram loads the skill content into the next LLM call's context
- E2E: ask the bot "rewrite this in obvious style: <text>" → it loads the skill on its own (without `/skill:`) and produces output that matches the skill's rules

#### F6.2 MCP bridge
Wrap MCP servers as `AgentTool` instances. One adapter file: takes an MCP server config (command, args, env) and exposes each MCP tool as a typed `AgentTool` with proper JSON schema.

Initial MCP servers wired in:
- **obsidian** — already used in F2.4 (read/write/search vault). Replaces the direct Obsidian integration with the MCP-backed version.
- **github** — read/write issues, PRs, files. Useful for Patrick's project work.
- **railway** — check deploys, get logs (Patrick already uses railway-deploy skill).
- **google-docs** — Docs/Sheets/Drive ops (Patrick already configured).

MCP servers run as child processes (stdio transport) launched and supervised by patrick2.0 at boot. HTTP-transport MCP servers also supported via config.

**Tests**
- Unit: MCP-tool-to-AgentTool adapter converts JSON schema correctly for a fixture MCP tool
- Unit: child process supervisor restarts a crashed MCP server up to 3 times, then disables it and emits a single Telegram error
- Integration: bot boot launches all configured MCP servers; `mcp__obsidian__list_directory` is callable as an AgentTool
- Integration: an MCP tool error surfaces as a normal tool error in the agent loop (no leaked stack traces)
- E2E: "list my recent GitHub issues" → bot calls the github MCP tool and returns the list

#### F6.3 Skill & MCP discoverability
Bot commands so Patrick can see what's loaded:
- `/skills` — list all loaded skills with descriptions
- `/mcp` — list all MCP servers + their tools, with health status (connected / restarting / disabled)
- `/reload` — re-scan skills directories and restart MCP servers without redeploying

**Tests**
- E2E: `/skills` returns ≥1 skill, formatted as a clean Telegram list
- E2E: `/mcp` returns each configured MCP server with its tool count and status
- Integration: `/reload` picks up a new skill file added to `~/.claude/skills/` after boot

---

### F7 — Operations

#### F7.1 Railway deploy
Single service, single Postgres add-on. Env vars documented in `.env.example`. Deploy via `railway up`.

**Tests**
- Manual: deploy succeeds, `/start` works against the production bot
- Verification: screenshot of healthy service in Railway dashboard (per Patrick's railway-deploy skill)

#### F7.2 Logging & error reporting
Structured JSON logs. Errors include trace + context (user message, tool call, model). Optional Sentry integration.

**Tests**
- Unit: logger never logs API keys or message bodies at `info` level (PII guard)
- Integration: a thrown error in a tool surfaces as a single bot message: "Something broke, I logged it" + creates an action history entry

#### F7.3 Backups
Postgres nightly backup to S3-compatible storage. Memory tables especially — losing them = losing the clone.

**Tests**
- Integration: backup script runs, restore script restores into a fresh DB and matches row counts
- Manual: monthly drill — restore last night's backup into a staging DB

---

## Roadmap (build order)

Patrick wants the full thing, feature by feature. Build in this order — each box must pass its tests before starting the next.

1. **Week 1:** F0 (foundation) — talkable Telegram bot with no integrations
2. **Week 2:** F1.1 + F1.3 + F1.5 — facts, history, memory-injected prompts
3. **Week 3:** F1.2 + F1.4 — thinking dumps, action history
4. **Week 4:** F6.1 + F6.2 + F6.3 — skills loader, MCP bridge, `/skills` `/mcp` `/reload` commands. Done early so F2 onwards can reuse it.
5. **Week 5:** F2.1 + F2.2 — Gmail + Calendar
6. **Week 6:** F2.3 + F2.4 — Todos + Obsidian (Obsidian via the F6.2 MCP bridge)
7. **Week 7:** F4.1 + F4.2 — scheduler + morning briefing
8. **Week 8:** F4.3 + F4.4 + F4.5 — meeting prep, urgent watcher, EOD recap
9. **Week 9:** F5 — approval flows, quiet hours, kill switch
10. **Week 10:** F3.1 — Telegram personal
11. **Week 11:** F3.3 — Slack
12. **Week 12:** F3.2 — WhatsApp (read-only, last because of TOS risk)
13. **Week 13:** F7 — production hardening, backups, monitoring

---

## Known risks & open questions

- **WhatsApp TOS:** `whatsapp-web.js` is unofficial and pairs with Patrick's primary number. Meta could detect automation and ban the account. Mitigations: read-only (no automated sending = much lower detection signal), 5-min poll cadence (not aggressive), no bulk operations, behaves like a logged-in WhatsApp Web session.
- **Telegram MTProto sessions:** session string in env is a high-value secret. Loss = account compromise. Need to rotate quarterly and document the rotation procedure.
- **Memory poisoning:** if the agent extracts a wrong fact ("Patrick hates X" when he doesn't), it will persist. Mitigation: weekly review prompt — bot lists 10 facts, Patrick approves/rejects.
- **Cost runaway:** OpenRouter usage with reasoning models can spike. Mitigation: per-day USD cap in router; bot refuses LLM calls beyond cap and tells Patrick.
- **Open question:** Multi-device. If Patrick wants to chat from desktop without his phone, do we add a web UI later? Out of scope for v1.
- **Open question:** Voice input. Telegram voice notes → Whisper → text? Nice-to-have, not in roadmap.

---

## Success definition (how we know we're done with v1)

- All F0–F7 features pass their tests
- Patrick used the bot every day for 14 consecutive days without prompting
- Manual eval scores: F1.5 "sounds like me" ≥4/5 avg, F4.2 morning briefing ≥5/7 useful days, F4.5 EOD recap ≥10/14 useful days
- Cost is under $50/month at Patrick's actual usage rate
