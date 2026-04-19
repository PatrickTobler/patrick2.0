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

# Pre-install npx-launched MCP servers so first call is fast (avoid 30s cold start)
RUN npm install -g \
    @kazuph/mcp-fetch@latest \
    @tacticlaunch/mcp-linear@latest \
    || true

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations

# Run migrations then start
CMD node node_modules/node-pg-migrate/bin/node-pg-migrate up -d DATABASE_URL --migrations-dir migrations \
    && node --enable-source-maps dist/index.js
