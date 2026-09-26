FROM denoland/deno:2.9.7 AS build
WORKDIR /app
COPY deno.json deno.lock package.json ./
RUN deno install --allow-scripts=npm:@tailwindcss/oxide --allow-scripts=npm:esbuild
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY tsconfig*.json ./
RUN mkdir -p /app/data /app/dist /deno-dir
ENV DENO_DIR=/deno-dir
RUN deno task build
FROM denoland/deno:2.9.7
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/app/data/taskpath-accounts.sqlite DENO_DIR=/deno-dir
COPY deno.json deno.lock package.json ./
COPY --from=build /deno-dir /deno-dir
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/public ./public
COPY --from=build /app/dist ./dist
COPY --from=build /app/tsconfig*.json ./
RUN mkdir -p /app/data && chown -R deno:deno /app /deno-dir
USER deno
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD deno eval 'const r = await fetch("http://127.0.0.1:3000/healthz"); Deno.exit(r.ok ? 0 : 1)'
CMD ["deno", "task", "start"]
