FROM node:22-alpine AS builder
WORKDIR /app

# Install build deps and source
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Strip dev dependencies
RUN npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# git for the Obsidian vault sync
RUN apk add --no-cache git ca-certificates

# Pre-install npx-launched MCP servers so first call is fast (avoid 30s cold start)
RUN npm install -g \
    @kazuph/mcp-fetch@latest \
    @tacticlaunch/mcp-linear@latest \
    || true

# Bash for the wise_query.sh helper bundled in skills/wise-bank/
RUN apk add --no-cache bash

# Masumi Agent Messenger CLI (for the masumi-agent-messenger skill)
RUN npm install -g @masumi_network/masumi-agent-messenger@latest || true

# The CLI stores credentials under $HOME/.config. Point HOME at the Railway
# volume so auth state persists across deploys.
ENV HOME=/data/home
ENV XDG_CONFIG_HOME=/data/home/.config
ENV XDG_DATA_HOME=/data/home/.local/share

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY skills ./skills

# Run migrations then start
CMD node node_modules/node-pg-migrate/bin/node-pg-migrate up -d DATABASE_URL --migrations-dir migrations \
    && node --enable-source-maps dist/index.js
