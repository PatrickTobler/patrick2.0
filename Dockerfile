FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

RUN npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

# System deps:
# - git / ca-certs: Obsidian vault sync, HTTPS
# - bash: wise_query.sh helper in skills/wise-bank/
# - curl / unzip: used by agent-browser install at runtime
# - Chrome runtime libs: required so agent-browser can drive headless Chromium.
#   We install these at build time so the first boot doesn't have to hit apt.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates bash curl unzip \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libasound2 libpangocairo-1.0-0 libpango-1.0-0 libnspr4 libatspi2.0-0 \
    libx11-6 libxcb1 libxext6 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Pre-install npx-launched MCP servers so first call is fast
RUN npm install -g \
    @kazuph/mcp-fetch@latest \
    @tacticlaunch/mcp-linear@latest \
    || true

# Masumi Agent Messenger CLI (for the masumi-agent-messenger skill)
RUN npm install -g @masumi_network/masumi-agent-messenger@latest || true

# agent-browser CLI (Reddit + LinkedIn subagents drive this). Chrome itself is
# downloaded on first boot into the /data volume so it survives redeploys.
#
# PINNED to 0.25.5. Both 0.26.0 and 0.27.0 regressed the Browserbase
# CDP-via-URL launch path: every `--cdp wss://...browserbase.com/...` call
# fails with "Auto-launch failed: CDP WebSocket connect failed: HTTP error:
# 410 Gone" even though the underlying session is healthy (raw WebSocket
# connect succeeds against the same URL). 0.25.5 is the last good version.
# Re-evaluate when a 0.26.x / 0.27.x patch fixes the launcher.
RUN npm install -g agent-browser@0.25.5 || true

# Scalable Capital CLI (`sc`) — used by the scalable skill for READ-ONLY broker
# queries (overview, transactions, holdings). Auth tokens persist on the
# /data/home volume via XDG_CONFIG_HOME, so `sc login` only needs to run once
# (interactively, via railway ssh).
#
# The real binary lives at /usr/local/lib/sc-real. /usr/local/bin/sc is a
# sandbox wrapper (scripts/sc-sandbox.sh) that hard-blocks every broker write
# subcommand (trade buy/sell/cancel, watchlist add/remove, price-alerts
# add/remove, savings-plans add/remove, context select, logout). Without this
# wrapper the agent's run_shell tool could call `sc broker trade ...` directly
# even though the sc_query.sh skill wrapper hides it.
ARG SC_VERSION=v0.2.0
COPY scripts/sc-sandbox.sh /usr/local/bin/sc
RUN chmod +x /usr/local/bin/sc \
    && curl -fsSL -o /tmp/sc.tar.gz \
        "https://github.com/ScalableCapital/scalable-cli/releases/download/${SC_VERSION}/sc-${SC_VERSION}-linux-x86_64-gnu.tar.gz" \
    && tar -xzf /tmp/sc.tar.gz -C /tmp \
    && mv "/tmp/sc-${SC_VERSION}-linux-x86_64-gnu/sc" /usr/local/lib/sc-real \
    && chmod +x /usr/local/lib/sc-real \
    && rm -rf /tmp/sc.tar.gz "/tmp/sc-${SC_VERSION}-linux-x86_64-gnu"

# WHOOP integration is handled in-process via the official OAuth Developer API
# (src/whoop/auth.ts + src/whoop/api.ts). The unofficial `whoop-cli` was tried
# first but its auth endpoint (api.prod.whoop.com/auth-service/v3/whoop) is
# WAF-blocked for data-center IPs — so the agent uses Authorization Code +
# refresh token instead (WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET / WHOOP_REFRESH_TOKEN env vars).

# The CLI + agent-browser store state under $HOME. Point HOME at the Railway
# volume so auth state + Chrome binary + Reddit session cookies persist across
# deploys.
ENV HOME=/data/home
ENV XDG_CONFIG_HOME=/data/home/.config
ENV XDG_DATA_HOME=/data/home/.local/share

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY skills ./skills
COPY scripts/masumi-bootstrap.sh ./scripts/masumi-bootstrap.sh
COPY scripts/scalable-bootstrap.sh ./scripts/scalable-bootstrap.sh
RUN chmod +x ./scripts/masumi-bootstrap.sh ./scripts/scalable-bootstrap.sh

# Boot: migrate DB, restore Masumi auth, seed scalable-cli config (idempotent,
# uses file-based session storage since Railway has no DBus/Secret Service),
# ensure Chrome is installed for agent-browser (idempotent — download only
# happens on the very first boot after a fresh volume), then start the bot.
CMD mkdir -p /data/home && \
    node node_modules/node-pg-migrate/bin/node-pg-migrate up -d DATABASE_URL --migrations-dir migrations && \
    ./scripts/masumi-bootstrap.sh ; \
    ./scripts/scalable-bootstrap.sh ; \
    (agent-browser install >/dev/null 2>&1 || true) ; \
    node --enable-source-maps dist/index.js
