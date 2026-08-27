# syntax=docker/dockerfile:1
#
# Two images out of one file.
#
#   · `runtime` — what actually crawls: compiled JavaScript, production dependencies, no compiler,
#     no test fixtures, no source. Runs as a non-root user because a scraper is a program that
#     parses hostile input for a living, and the blast radius of a parser bug should not include
#     the container's filesystem.
#
#   · `demo` — the fake tribunal from the test suite, kept as a separate target so the scaling
#     demonstration has a site it is allowed to hammer. It never ships anywhere; it exists so that
#     `--scale worker=3` can be shown without pointing three workers at a public court server.
#
# The build is ordered so that a source change reuses the dependency layer: `npm ci` runs against
# the lockfile alone, before any source is copied in.
#
# The base tag is exact — `node:22.23.2-alpine`, not `node:22-alpine`. A floating tag means the
# image someone builds in six months is not the image these tests ran against, and the first
# symptom of that is a failure nobody can reproduce.

FROM node:22.23.2-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Production dependencies only, resolved from the same lockfile — not a pruned copy of the dev
# tree, which is how a dev-only package ends up in a released image.
FROM node:22.23.2-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22.23.2-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Signals reach PID 1 unchanged: the crawl handles SIGTERM itself, checkpoints, and exits 130.
# Wrapping it in a shell would swallow that and leave `docker stop` to kill it after ten seconds.
RUN apk add --no-cache tini
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# `data/` is only used by the no-Docker fallback, but a container that falls back and then cannot
# write is a worse failure than one that never falls back at all.
RUN mkdir -p /app/data /app/reports /app/exports && chown -R node:node /app
USER node

# The probe is the CLI's own healthcheck: it reads the database and refuses to migrate it. Given
# 40 s to start, because the first container up waits for Postgres to accept connections.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD ["node", "dist/app/main.js", "healthcheck"]

ENTRYPOINT ["/sbin/tini", "--", "node", "dist/app/main.js"]
CMD ["crawl"]

FROM deps AS demo
WORKDIR /app
ENV NODE_ENV=development
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts
USER node
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=5s --start-period=10s --retries=10 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/pjeconsulta/ConsultaPublica/listView.seam').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["npx", "tsx", "scripts/fake-server.ts"]
