# Same pinned Node 22 base as the dashboard API. Update the digest deliberately.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /build
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod --ignore-scripts

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
ARG VCS_REF
LABEL org.opencontainers.image.title="OpenAgency Social" \
      org.opencontainers.image.revision="${VCS_REF}"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /build/package.json ./
COPY --from=build --chown=node:node /build/node_modules ./node_modules
COPY --from=build --chown=node:node /build/dist ./dist
COPY --chown=node:node drizzle ./drizzle
USER node
EXPOSE 3410
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3410) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
# Migrations: node dist/cli/migrate.js with DATABASE_MIGRATION_URL, in a separate task.
CMD ["node", "dist/main.js"]
