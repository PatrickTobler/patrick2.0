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

# `npx` for MCP server packages needs cache; preinstall the cloud MCPs to avoid runtime cold starts
RUN npm install -g \
    @modelcontextprotocol/server-github@latest \
    @railway/mcp-server@latest \
    @duneanalytics/mcp@latest \
    || true

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations

# Run migrations then start
CMD node node_modules/node-pg-migrate/bin/node-pg-migrate up -d DATABASE_URL --migrations-dir migrations \
    && node --enable-source-maps dist/index.js
