# patrick2.0

Personal assistant agent — a digital clone of Patrick. Talks to him over Telegram, runs on Railway, accumulates a model of how he thinks over time.

**Goal:** "Feels like a clone of me." Not "an AI that helps Patrick." A digital twin that absorbs his preferences, evolving thinking, and action history, then acts as an extension of him.

Specs are in [`SPECS.md`](./SPECS.md). This README is the architecture reference.

---

## Architecture

### System diagram

```mermaid
flowchart TB
    U[Patrick] -->|Telegram| TG[Telegram Bot API]
    MM[Masumi Network] -->|encrypted threads| MM_CLI
    MAC[Patrick's Mac<br/>Obsidian + Obsidian Git plugin] <-->|git sync 5 min| VAULT_REPO

    subgraph RW[Railway service: patrick2-app]
        direction TB
        GRAM[grammy bot<br/>allowlisted chat_id]
        SCHED[node-cron scheduler<br/>reloaded on CRUD]
        AGENT["pi-agent-core Agent loop<br/>fast: MiMo V2 Pro<br/>reasoning: Kimi K2-Thinking<br/>coding: Qwen3-Coder Plus"]
        HOOKS[beforeToolCall / afterToolCall<br/>persistence + action history]
        TOOLS[Tool registry]
        MCP_BR[MCP bridge<br/>stdio + HTTP transports]
        MM_CLI[masumi-agent-messenger CLI<br/>/data/home config]
        VAULT_FS[Obsidian vault<br/>/data/vault<br/>git pull before read<br/>git commit+push after write]
    end

    TG <--> GRAM
    GRAM --> AGENT
    SCHED --> AGENT
    AGENT <--> HOOKS
    HOOKS --> DB
    AGENT --> TOOLS
    TOOLS --> MCP_BR
    TOOLS --> MM_CLI
    TOOLS --> VAULT_FS
    VAULT_FS <-->|HTTPS push/pull| VAULT_REPO

    AGENT -->|chat + embeddings| OR[OpenRouter]
    OR -->|Kimi / MiMo / Qwen / Claude| LLM[LLM providers]

    TOOLS -->|HTTPS| GH[GitHub MCP]
    TOOLS -->|HTTPS| LIN[Linear MCP]
    TOOLS -->|HTTPS| DUNE[Dune MCP]
    TOOLS -->|stdio| FET[fetch MCP]
    TOOLS -->|OAuth refresh| GCAL[Google Calendar API]
    TOOLS -->|OAuth refresh| GM[Gmail API]

    DB[(Postgres + pgvector<br/>messages / facts / thinking /<br/>actions / todos / schedules / kv)]
    VAULT_REPO[(github.com/PatrickTobler/<br/>patrick-vault private repo)]
    MM_CLI -->|OAuth| MM
```

### Inbound Telegram message lifecycle

```mermaid
sequenceDiagram
    actor P as Patrick (Telegram)
    participant G as grammy
    participant L as handleUserMessage
    participant DB as Postgres
    participant M as Memory context
    participant A as pi Agent
    participant T as Tools
    participant O as OpenRouter

    P->>G: message "do X"
    G->>G: drop if chat_id != ALLOWED
    G->>L: dispatch
    L->>DB: insertMessage(user + raw_message)
    par background
        L->>DB: embed message
        L->>A: ingestFactsFromMessage (LLM extract + upsert)
    end
    L->>M: recall top facts + thinking + history
    M->>DB: pgvector similarity queries
    L->>A: new Agent(system=SYSTEM+memory, tools=all)
    loop until stop
        A->>O: chat completion w/ tools
        O-->>A: text delta / tool call
        opt text_delta
            A-->>G: stream edit Telegram message (debounced 600ms)
        end
        opt tool call
            A->>T: execute tool
            T->>DB: insertPendingAction
            T-->>A: AgentToolResult
            T->>DB: resolveAction
        end
    end
    L->>DB: persist every new AgentMessage (assistant + tool calls + tool results)
```

### Scheduled prompt lifecycle

```mermaid
sequenceDiagram
    participant C as node-cron tick
    participant S as scheduler/service
    participant R as runScheduledPrompt
    participant M as Memory context
    participant A as pi Agent (no auto-stream)
    participant T as Tools (incl. send_telegram_message)
    participant DB as Postgres

    C->>S: fire (cron match in TZ)
    S->>DB: load schedule row by id
    S->>R: runScheduledPrompt(id, prompt)
    R->>M: recall memory for prompt
    R->>A: new Agent(system=memory+SCHEDULED_BANNER, tools=all)
    Note over A: Agent knows it's autonomous.<br/>Silence is valid.<br/>Must explicitly call send_telegram_message.
    loop until stop
        A->>T: tool calls (memory, gmail, linear, shell, ...)
        T->>DB: actions logged as cron:<id>:<tool>
        A->>A: decide: ping or stay silent
        opt decided to ping
            A->>T: send_telegram_message(text)
            T-->>Patrick: new Telegram message (fresh, not in-thread)
        end
    end
    R->>DB: markFired(id)
```

### Memory write + recall path

```mermaid
flowchart LR
    MSG[User message]
    MSG --> PERSIST[insertMessage]
    MSG --> BG_FACTS[Background: extractFacts via LLM]
    MSG --> BG_EMBED[Background: embed for history search]

    BG_FACTS --> UPSERT{Near-duplicate?<br/>cosine ≥ 0.85}
    UPSERT -- yes, bump confidence --> FACTS_TABLE[(memory_facts)]
    UPSERT -- yes, longer text --> REPLACE[Replace text, keep id]
    UPSERT -- no --> FACTS_TABLE

    BG_EMBED --> MSG_VEC[(messages.embedding)]
    PERSIST --> MSG_ROW[(messages.raw_message jsonb)]

    NEW_TURN[Next turn starts] --> RECALL[buildSystemPromptWithMemory]
    RECALL -->|top 8 cosine ≥ 0.30| FACTS_TABLE
    RECALL -->|top 4 cosine ≥ 0.35| THINKING_TABLE[(memory_thinking)]
    RECALL -->|top 3 cosine ≥ 0.40 user msgs| MSG_VEC
    RECALL --> PROMPT[Assembled system prompt]

    EXPLICIT[store_thinking etc.] --> FACTS_TABLE
    EXPLICIT --> THINKING_TABLE
    TOOL_CALLS[Every tool call] -->|beforeToolCall / afterToolCall| ACTIONS[(memory_actions)]
```

### Vault (Obsidian) sync lifecycle

```mermaid
flowchart LR
    PATRICK[Patrick edits note<br/>in Obsidian on Mac]
    PATRICK -->|Obsidian Git plugin<br/>auto-commit every 5 min| VAULT_REPO

    VAULT_REPO[(GitHub<br/>patrick-vault)] -->|git pull --rebase<br/>before any read| VAULT_FS
    VAULT_FS[/data/vault<br/>Railway volume] -->|read_note / search_notes| AGENT[Agent]

    AGENT -->|write_note / append_note| VAULT_FS
    VAULT_FS -->|git add + commit + push<br/>after every write| VAULT_REPO

    VAULT_REPO -->|git pull every 5 min<br/>in Obsidian Git plugin| PATRICK
```

---

## ASCII box diagram (if Mermaid doesn't render)

```
┌─────────────┐     long-poll        ┌────────────────────────────────────────┐
│  Telegram   │ ←───────────────────→│  patrick2.0 service (Railway)          │
│  @padierfind│                      │                                        │
│   _2_0_bot  │                      │  ┌──────────────────────────────────┐  │
└─────────────┘                      │  │  pi-agent-core Agent loop        │  │
                                     │  │  (badlogic/pi-mono framework)    │  │
                                     │  │                                  │  │
                                     │  │  - LLM router → OpenRouter       │  │
                                     │  │    fast: Kimi K2.5               │  │
                                     │  │    reasoning: Kimi K2-Thinking   │  │
                                     │  │    coding: Qwen3-Coder Plus      │  │
                                     │  │  - Tool registry                 │  │
                                     │  │  - beforeToolCall /              │  │
                                     │  │    afterToolCall hooks           │  │
                                     │  │  - Streaming events              │  │
                                     │  └──────────────────────────────────┘  │
                                     │             │                          │
                                     │             ▼                          │
                                     │  ┌──────────────────────────────────┐  │
                                     │  │  Tools surfaced to the model     │  │
                                     │  │                                  │  │
                                     │  │  • Memory:  facts, thinking,     │  │
                                     │  │             todos, time, actions │  │
                                     │  │  • Vault:   list/read/write/     │  │
                                     │  │             search/append        │  │
                                     │  │  • Google:  Calendar (3),        │  │
                                     │  │             Gmail (4)            │  │
                                     │  │  • Skills:  list/read/reload     │  │
                                     │  │             (29 bundled)         │  │
                                     │  │  • MCP:     104 tools across     │  │
                                     │  │             github, linear,      │  │
                                     │  │             dune, fetch          │  │
                                     │  │  • Subagents: coder, researcher  │  │
                                     │  └──────────────────────────────────┘  │
                                     │                                        │
                                     │  ┌──────────────────────────────────┐  │
                                     │  │  Persistence                     │  │
                                     │  │  • Postgres + pgvector (Railway) │  │
                                     │  │  • Vault on /data volume (git)   │  │
                                     │  └──────────────────────────────────┘  │
                                     └─────────┬──────────────┬──────────────┘
                                               │              │
                                               ▼              ▼
                                     ┌──────────────┐  ┌─────────────────┐
                                     │  Postgres    │  │ github.com/     │
                                     │  + pgvector  │  │ PatrickTobler/  │
                                     │  (Railway)   │  │ patrick-vault   │
                                     └──────────────┘  └─────────────────┘
```

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 + TypeScript (ESM, strict) | Pi-mono is TypeScript |
| Agent framework | `@mariozechner/pi-agent-core` + `@mariozechner/pi-ai` | The "use pi as much as possible" principle |
| LLM gateway | OpenRouter | Single key, switch models by id, embeddings + chat |
| Telegram | `grammy` | Mature, typed, allowlist middleware |
| DB | Postgres + pgvector | Memory needs semantic recall |
| Migrations | `node-pg-migrate` | Plain JS, runs at container start |
| Lint/format | Biome | Fast, single config |
| Tests | Vitest | Standard for ESM TS |
| Logging | Pino + redaction | Structured JSON, never logs API keys |
| Deploy | Railway | One service + Postgres + volume |

---

## The agent loop (per Telegram message)

```
user sends "X" on Telegram
  │
  ├─ grammy middleware: drop if chat_id != ALLOWED_CHAT_ID
  │
  ├─ insertMessage({ role:"user", content:"X" })
  │     └─ background: embed and write embedding column
  │
  ├─ build system prompt:
  │     SYSTEM_PROMPT
  │     + skills inventory (29 bundled, name + description)
  │     + recallFacts("X")     → top 8 facts above 0.30 sim
  │     + recallThinking("X")  → top 4 thoughts above 0.35 sim
  │     + searchHistory("X")   → top 3 prior user messages above 0.40 sim
  │
  ├─ load last 50 messages from DB → AgentMessage[]
  │
  ├─ new pi Agent({
  │       systemPrompt: <augmented>,
  │       model: chooseModel("fast")     // Kimi K2.5
  │       tools: [native, vault, google, skills, mcp, subagents]
  │       beforeToolCall: insertPendingAction(tool, args)
  │       afterToolCall:  resolveAction(id, outcome, output)
  │   })
  │
  ├─ background: ingestFactsFromMessage("X")
  │     - LLM extract step → 0..N candidate facts
  │     - upsertFact(text) for each → dedupe via pgvector cosine
  │
  ├─ agent.prompt("X")
  │     ├─ pi calls model with full context
  │     ├─ on text_delta → buffer + debounced edit_message_text
  │     ├─ on tool_call  → execute → afterToolCall hook
  │     └─ may loop: model → tool → model → ... until done
  │
  └─ insertMessage({ role:"assistant", content:<final text> })
```

---

## Memory layers (the core IP)

Everything in Postgres. Embeddings are 1536-dim from `openai/text-embedding-3-small` via OpenRouter.

| Table | Purpose | Recall |
|---|---|---|
| `messages` | Every Telegram turn (user + assistant) | Semantic search via embedding column |
| `memory_facts` | Stable truths about Patrick | Cosine top-K, dedupe at sim ≥ 0.85 (longer phrasing wins) |
| `memory_thinking` | Evolving positions, in-progress reasoning | Semantic top-K + topic tag filter |
| `memory_actions` | Every tool call: input, output, outcome | By tool, by outcome, by time |
| `notes` | Free-form notes (currently unused — vault is preferred) | n/a |
| `todos` | Native task store | Open / due-within-N-hours / completed |
| `kv` | Generic key-value (config, state) | Direct |

**Critical distinction enforced in the system prompt:** facts are stable, thinking is evolving. "I prefer async" → fact. "I'm starting to think the right play is X because Y" → thinking.

**Auto-extraction:** after every user message, a background LLM call extracts candidate stable facts and upserts them. Dedupe is cosine similarity ≥ 0.85; the longer phrasing wins on merge so detail accumulates rather than getting lost.

**Memory injection:** `buildSystemPromptWithMemory(userText)` runs before every turn. The model sees relevant facts, recent thinking, and matching past messages stitched into the system prompt — no separate retrieval tool needed.

---

## Tools surfaced to the model

Total surface: ~140 tools at any given turn. The pi Agent receives all of them in every LLM call (their JSON schemas burn ~40-50k input tokens — acceptable on Kimi K2.5's 262k context, with possible progressive disclosure later).

### Native (built in this repo)
| Tool | Group | What |
|---|---|---|
| `remember_fact`, `list_facts`, `forget_fact` | Memory | Stable facts about Patrick |
| `store_thinking`, `recall_thinking`, `list_thinking` | Memory | Evolving positions |
| `add_todo`, `list_todos`, `complete_todo`, `snooze_todo`, `delete_todo` | Memory | Native todos |
| `current_time` | Time | Now in Patrick's tz, for resolving "tomorrow" → ISO |
| `query_actions` | Memory | Audit tool history |
| `list_skills`, `read_skill`, `reload_skills` | Skills | Discover + load skill files |
| `list_mcp_servers` | Meta | Status of connected MCP servers |
| `list_notes`, `read_note`, `search_notes`, `write_note`, `append_note` | Vault | Read/write Obsidian via git sync |
| `list_events`, `create_event`, `delete_event` | Google Calendar | Direct API via OAuth refresh |
| `list_emails`, `read_email`, `draft_email`, `send_draft` | Gmail | Drafts always require explicit Patrick approval |
| `delegate_to_coder`, `delegate_to_researcher` | Subagents | Spawn focused sub-Agents |

### Skills (bundled in `./skills/`, loaded via Agent Skills standard)
Progressive disclosure: only `name + description` are in the system prompt; the agent calls `read_skill` to load full SKILL.md content on demand.

| Bundled (11) | Purpose |
|---|---|
| `ads-google` / `meta` / `linkedin` / `tiktok` / `microsoft` / `apple` / `youtube` | Per-platform paid ad analysis |
| `obvious-communication` | Plain-language writing principles (Obvious Adams, 1916) |
| `fal-ai` | Generate images/video/audio via fal.ai (FAL_KEY env) |
| `gtm-cli` | GTM tag management + Meta Ads API queries |
| `wise-bank` | Wise account/transaction queries (WISE_API_TOKEN env) |

In dev mode the loader also reads `~/.claude/skills/` so 29 skills are available locally.

### MCP servers (HTTP + stdio bridge)
| Server | Tools | Auth |
|---|---|---|
| github | 41 | `GITHUB_TOKEN` (HTTP) |
| linear | 42 | `LINEAR_API_KEY` (npx stdio) |
| dune | 20 | `DUNE_API_KEY` (HTTP) |
| fetch | 1 | none (npx stdio) |

The MCP bridge connects servers at boot, lists their tools, and wraps each as an `AgentTool` (sanitized name `mcp_<server>__<tool>`). Failed servers (e.g. sokosumi OAuth) log a warning and don't block startup.

In dev mode, additional MCP servers from `~/.claude.json` get loaded (obsidian, google-docs, etc.) — those are local-only and not portable to Railway.

### Subagents
A subagent is a tool whose `execute` spawns a fresh `Agent` with a focused system prompt + scoped tool set, runs it to completion via `runSubagent`, returns the final text + a turn count.

| Subagent | Model | Scoped tools |
|---|---|---|
| **coder** (`delegate_to_coder`) | `qwen/qwen3-coder-plus` (1M ctx, coding-specialized) | github MCP, fetch MCP, vault, facts |
| **researcher** (`delegate_to_researcher`) | `moonshotai/kimi-k2-thinking` (262k ctx, reasoning) | fetch MCP, vault, facts, recall_thinking |

---

## Vault (Obsidian) sync

Patrick's Obsidian vault is mirrored to a private GitHub repo `PatrickTobler/patrick-vault`. The bot clones it to `/data/vault` (a Railway volume) on first boot, pulls before every read, commits + pushes after every write. Auth uses the bot's `GITHUB_TOKEN` (no separate deploy key).

On Patrick's Mac, the **Obsidian Git plugin** auto-pulls every 5 min and auto-pushes every 5 min. Two-way sync, both ends free to write. Conflict warning: if both edit the same file simultaneously, manual rebase.

`.gitignore` in the vault excludes `.obsidian/workspace*.json` (UI state churns and would conflict constantly).

---

## Google OAuth (Calendar + Gmail)

One Google Cloud Desktop OAuth client covers both APIs. Scopes:
- `calendar` (full read/write)
- `gmail.readonly`, `gmail.modify`, `gmail.send`
- `userinfo.email`

The one-time auth runs locally via `scripts/google-oauth.ts` (loopback flow on `localhost:8765`). Result: a long-lived **refresh token** stored as `GOOGLE_REFRESH_TOKEN` env var. The bot exchanges it for short-lived access tokens at runtime, cached in memory until 1 min before expiry.

`gmail.send_draft` requires explicit Patrick approval per the spec — never auto-sends.

---

## Pi-first principle

Use pi-mono primitives wherever they exist. We don't write a custom agent loop, custom tool runtime, or custom skill loader. Concretely:

| Pi primitive | Where we use it |
|---|---|
| `Agent` class | Main loop in `src/agent/loop.ts`; subagent runner in `src/agent/subagents/runner.ts` |
| `AgentTool` | Every tool: facts, thinking, todos, vault, gmail, calendar, skill discovery, subagents, MCP |
| `convertToLlm` | Pass-through (we already use Message shape) |
| `transformContext` | Memory injection happens in our system prompt build instead — equally valid, cleaner for this case |
| `beforeToolCall` / `afterToolCall` hooks | Action history (F1.4) — every tool call logged with input + outcome |
| `getApiKey` | Inject OpenRouter key per-request |
| Streaming events | Telegram message edit-in-place |

Pi has no native MCP client → we wrote `src/mcp/{client,bridge,config}.ts` using `@modelcontextprotocol/sdk`.
Pi has no native skills loader exported (it's internal to the coding-agent package) → we wrote `src/skills/loader.ts` to the same Agent Skills spec.

---

## Code layout

```
patrick2.0/
├── src/
│   ├── index.ts                  # entry point: boot bot + MCP bridge
│   ├── config.ts                 # env var loading + validation
│   ├── log.ts                    # pino logger with PII redaction
│   │
│   ├── telegram/
│   │   └── bot.ts                # grammy bot, allowlist, dispatcher
│   │
│   ├── agent/
│   │   ├── loop.ts               # handleUserMessage — the main turn flow
│   │   ├── system-prompt.ts      # base prompt with stack/memory/tools awareness
│   │   ├── memory-context.ts     # buildSystemPromptWithMemory — recall + injection
│   │   ├── facts.ts              # background fact extractor (LLM-driven)
│   │   ├── tools/                # one file per tool family
│   │   │   ├── facts.ts
│   │   │   ├── thinking.ts
│   │   │   ├── todos.ts
│   │   │   ├── time.ts
│   │   │   ├── actions.ts
│   │   │   ├── skills.ts
│   │   │   ├── mcp-meta.ts
│   │   │   ├── vault.ts
│   │   │   ├── calendar.ts
│   │   │   └── gmail.ts
│   │   └── subagents/
│   │       ├── runner.ts         # generic runSubagent helper
│   │       ├── coder.ts          # Qwen3-Coder Plus + GitHub + vault
│   │       └── researcher.ts     # Kimi K2-Thinking + fetch + vault
│   │
│   ├── llm/
│   │   ├── router.ts             # model class → Model<openai-completions> over OpenRouter
│   │   └── embeddings.ts         # OpenRouter embeddings client (text-embedding-3-small)
│   │
│   ├── db/
│   │   ├── pool.ts               # pg pool singleton
│   │   └── repos/                # one file per table
│   │       ├── messages.ts
│   │       ├── facts.ts
│   │       ├── thinking.ts
│   │       ├── actions.ts
│   │       └── todos.ts
│   │
│   ├── google/
│   │   ├── auth.ts               # OAuth refresh-token → access-token cache
│   │   ├── calendar.ts           # Calendar v3 API client
│   │   └── gmail.ts              # Gmail v1 API client
│   │
│   ├── mcp/
│   │   ├── config.ts             # load MCP server configs (builtin + ~/.claude.json in dev)
│   │   ├── client.ts             # connect via stdio or HTTP transport
│   │   └── bridge.ts             # wrap MCP tools as AgentTool[]
│   │
│   ├── skills/
│   │   └── loader.ts             # Agent Skills spec loader (frontmatter parser, dedupe)
│   │
│   └── vault/
│       ├── sync.ts               # git clone/pull/commit/push wrappers
│       └── notes.ts              # safe path resolution + read/write/search
│
├── skills/                       # bundled SKILL.md files (baked into Docker image)
│   ├── ads-google/
│   ├── ads-meta/
│   ├── ... (11 skills total)
│   └── wise-bank/
│       ├── SKILL.md
│       └── wise_query.sh
│
├── migrations/                   # node-pg-migrate, run at container start
│   ├── 1700000000000_init.cjs
│   ├── 1700000001000_messages_embedding.cjs
│   └── 1700000002000_todos.cjs
│
├── scripts/
│   └── google-oauth.ts           # one-time OAuth flow runner
│
├── Dockerfile                    # multi-stage: build TS, prune dev deps, install git + bash
├── package.json
├── tsconfig.json / tsconfig.build.json
├── biome.json
├── vitest.config.ts
├── .env.example
└── SPECS.md                      # the original spec (north star, features, tests)
```

---

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | yes | Chat + embeddings |
| `TELEGRAM_BOT_TOKEN` | yes | BotFather token |
| `TELEGRAM_OWNER_CHAT_ID` | yes | Patrick's numeric Telegram id (allowlist) |
| `DATABASE_URL` | yes | Postgres URL (Railway internal in prod) |
| `NODE_ENV` | no | `production` switches off dev-only paths (e.g. `~/.claude.json` MCP loading) |
| `LOG_LEVEL` | no | pino level, default `info` |
| `VAULT_REPO` | no | Git URL of the Obsidian vault repo |
| `VAULT_DIR` | no | Where to clone the vault, default `/data/vault` |
| `GITHUB_TOKEN` | no | Auth for GitHub MCP + vault git push |
| `LINEAR_API_KEY` | no | Linear MCP |
| `DUNE_API_KEY` | no | Dune MCP |
| `GOOGLE_CLIENT_ID` | no | OAuth client (Calendar + Gmail) |
| `GOOGLE_CLIENT_SECRET` | no | OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | no | Long-lived refresh token from `scripts/google-oauth.ts` |
| `FAL_KEY` | no | fal.ai (used by `fal-ai` skill) |
| `WISE_API_TOKEN` | no | Wise (used by `wise-bank` skill) |
| `META_ADS_TOKEN`, `META_PIXEL_ID`, `META_AD_ACCOUNT_ID` | no | Meta Ads (used by `gtm-cli` skill) |

---

## Local development

```bash
# Install deps + run tests
npm install
npm test
npm run check    # biome + tsc

# Run the bot locally (long-poll Telegram)
cp .env.example .env
# fill in the 4 required vars at minimum
npm run dev
```

Migrations need to be applied to the configured `DATABASE_URL`:

```bash
npm run migrate:up
```

The OAuth flow for Google (one-time):

```bash
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npx tsx scripts/google-oauth.ts
# Copy the printed GOOGLE_REFRESH_TOKEN into your .env or Railway env
```

---

## Deploy (Railway)

```bash
railway link    # if not linked already
railway up --service patrick2-app --ci
```

The Dockerfile:
1. Builds TS → `dist/`
2. Prunes dev deps
3. Installs `git`, `bash`, `ca-certificates` in the runtime image
4. Copies `dist/`, `migrations/`, `skills/` into the final stage
5. CMD runs migrations then starts the Node process

Railway resources:
- **patrick2-app** service (this code)
- **Postgres** service (manually created via GraphQL — pgvector image)
- Volume mounted at `/data` for the vault

---

## What's intentionally NOT here yet

Per [`SPECS.md`](./SPECS.md), the roadmap continues with:
- **F4** — proactivity (scheduler, morning briefing, T-10 meeting prep, urgent email watcher, EOD recap)
- **F5** — approval flows, quiet hours, kill switch
- **F3** — personal channel ingestion (Telegram personal, Slack, WhatsApp read-only)
- **F7** — production hardening (backups, structured monitoring, webhook switch)

The bot is fully reactive today. F4 is what makes it proactive — the scheduler watches state and pings Patrick when something matters.
