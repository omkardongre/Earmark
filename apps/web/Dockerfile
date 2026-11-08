# Web app image for Cloud Run. Build from the repository root:
#   docker build -f apps/web/Dockerfile .
# Runtime config (Try it keys) comes from env / Secret Manager, never from the image.
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY scripts/package.json scripts/
RUN pnpm install --frozen-lockfile --filter @earmark/web
COPY apps/web apps/web
# Public settings are compiled into the client at build time, so each network gets its own image.
# Empty means "use the testnet default" (config.ts treats "" as unset).
ARG NEXT_PUBLIC_NETWORK= NEXT_PUBLIC_CONTRACT= NEXT_PUBLIC_DAO= NEXT_PUBLIC_CODE_HASH=
RUN pnpm --dir apps/web build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 8080
CMD ["node", "apps/web/server.js"]
