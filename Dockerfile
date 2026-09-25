FROM oven/bun:1.4.2-alpine AS build
WORKDIR /app
COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun public ./public
COPY --chown=bun:bun scripts ./scripts
COPY --chown=bun:bun tsconfig*.json ./
RUN mkdir -p /app/data /app/dist && chown bun:bun /app/data /app/dist
USER bun
RUN bun run build
FROM oven/bun:1.4.2-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/app/data/taskpath-accounts.sqlite
COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY --from=build --chown=bun:bun /app/src ./src
COPY --from=build --chown=bun:bun /app/public ./public
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --from=build --chown=bun:bun /app/tsconfig*.json ./
RUN mkdir -p /app/data && chown bun:bun /app/data
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD bun -e 'const r = await fetch("http://127.0.0.1:3000/healthz"); process.exit(r.ok ? 0 : 1)'
CMD ["bun", "run", "start"]
