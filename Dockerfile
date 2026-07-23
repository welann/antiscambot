# syntax=docker/dockerfile:1

FROM node:22-alpine AS build

WORKDIR /app

RUN corepack enable \
    && corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY bot.ts digest.ts tsconfig.json ./
RUN pnpm exec tsc \
    && pnpm prune --prod

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    KEYWORDS_FILE=/app/data/keywords.txt \
    ADMINS_FILE=/app/data/admins.txt \
    DIGEST_DB_FILE=/app/data/antiscambot.sqlite \
    DIGEST_CRON="0 12 * * *" \
    DIGEST_TIMEZONE=Asia/Shanghai \
    DIGEST_SAMPLE_SIZE=10

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/bot.js ./bot.js
COPY --from=build --chown=node:node /app/digest.js ./digest.js

RUN mkdir -p /app/data \
    && chown node:node /app/data

VOLUME ["/app/data"]

USER node

CMD ["node", "bot.js"]
