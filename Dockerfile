# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN corepack enable \
    && corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY bot.ts digest.ts link-submission.ts calendar.ts tsconfig.json ./
RUN pnpm exec tsc \
    && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-noto-cjk fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    KEYWORDS_FILE=/app/data/keywords.txt \
    ADMINS_FILE=/app/data/admins.txt \
    DIGEST_DB_FILE=/app/data/antiscambot.sqlite \
    DIGEST_CRON="0 12 * * *" \
    DIGEST_TIMEZONE=Asia/Shanghai \
    DIGEST_SAMPLE_SIZE=10 \
    DIGEST_SEND_MAX_ATTEMPTS=3 \
    CALENDAR_BROWSER_PATH=/usr/bin/chromium

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/bot.js ./bot.js
COPY --from=build --chown=node:node /app/digest.js ./digest.js
COPY --from=build --chown=node:node /app/link-submission.js ./link-submission.js
COPY --from=build --chown=node:node /app/calendar.js ./calendar.js
COPY --chown=node:node calendar-studio/renderer.js calendar-studio/input.js calendar-studio/templates.js ./calendar-studio/
COPY --chown=node:node calendar-studio/assets/paper.png ./calendar-studio/assets/paper.png
COPY --chown=node:node keywords.txt /app/defaults/keywords.txt
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /app/data \
    && chown node:node /app/data

VOLUME ["/app/data"]

USER node

ENTRYPOINT ["docker-entrypoint.sh"]

CMD ["node", "bot.js"]
