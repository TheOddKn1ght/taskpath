FROM oven/bun:1.4.2-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/app/data/taskpath.sqlite
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun public ./public
COPY --chown=bun:bun scripts ./scripts
RUN mkdir -p /app/data /app/dist && chown bun:bun /app/data /app/dist
USER bun
RUN bun run build
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD bun -e 'const r = await fetch("http://127.0.0.1:3000/healthz"); process.exit(r.ok ? 0 : 1)'
CMD ["bun", "run", "start"]
