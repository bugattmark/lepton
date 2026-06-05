# One always-on Node service (landing + auth + dashboard + Baileys sessions).
# Node 24 runs the TypeScript directly (native type stripping) — no build step.
FROM node:24-slim

WORKDIR /app

# install runtime deps only (skip optional native media deps we don't use)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --omit=optional || npm install --omit=dev --omit=optional

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
# persist SQLite DB + per-tenant WhatsApp auth here (mount a volume in Railway)
ENV DATA_DIR=/app/data
ENV DB_PATH=/app/data/app.db

EXPOSE 8080
CMD ["node", "src/server.ts"]
