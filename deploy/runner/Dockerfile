# Browser runner: Playwright's Ubuntu image (Chromium matching playwright-core
# 1.64.1) plus a virtual display and noVNC for human takeover.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /build
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod --ignore-scripts

FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea
ARG VCS_REF
LABEL org.opencontainers.image.title="OpenAgency Social Browser Runner" \
      org.opencontainers.image.revision="${VCS_REF}"
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=pwuser:pwuser /build/package.json ./
COPY --from=build --chown=pwuser:pwuser /build/node_modules ./node_modules
COPY --from=build --chown=pwuser:pwuser /build/dist ./dist
COPY --chmod=0755 deploy/runner/entrypoint.sh /usr/local/bin/runner-entrypoint
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
USER pwuser
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://' + (process.env.RUNNER_HOST || '127.0.0.1') + ':' + (process.env.RUNNER_PORT || 3430) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["runner-entrypoint"]
