# One image for the API and both worker roles — they share every package, and a
# separate image per role would triple the build for no isolation gain on a demo.
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json tsconfig.build.json ./
COPY packages ./packages
COPY apps ./apps
COPY workers ./workers
RUN npm ci --no-audit --no-fund
# --force, for the same reason as Dockerfile.verifier: any incremental state that
# reaches the context would make every project look up to date and tsc would
# emit nothing. The context now excludes it; the build must not depend on that.
RUN npx tsc -b tsconfig.build.json --force

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY --from=build /app/workers ./workers
COPY scripts ./scripts
COPY infra/migrations ./infra/migrations
RUN npm ci --omit=dev --no-audit --no-fund

# The workers journal their commitments here and mirror every artifact. Losing
# it costs a verifier the ability to reveal what it already committed to, so it
# is a named volume in compose rather than container-local scratch.
RUN mkdir -p /app/.proofrelay
