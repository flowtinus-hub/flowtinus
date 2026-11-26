# The server's image: the api (api/server.ts) and the supervisor with its workers (supervisor/main.ts) run from it,
# each as its own container (docker-compose.yml, profile "server"). Built from the repository root (the workspace:
# flowtinus.core is a dependency, read as TypeScript like in development).
#
#   docker compose --profile server build
FROM oven/bun:1.4.4-slim

WORKDIR /app
ENV NODE_ENV=production

# the dependencies first (cached while the manifests do not change): only the server's, the CLI's and the core's, no dev ones
COPY package.json bun.lock ./
COPY flowtinus.core/package.json flowtinus.core/
COPY flowtinus.cli/package.json flowtinus.cli/
COPY flowtinus.server/package.json flowtinus.server/
COPY flowtinus.editor/package.json flowtinus.editor/
COPY flowtinus.perf/package.json flowtinus.perf/
RUN bun install --frozen-lockfile --production --filter '@flowtinus/server' --filter '@flowtinus/cli'

# the code (.dockerignore keeps out node_modules, .env files, tests, the editor and the perf package)
COPY flowtinus.core/src flowtinus.core/src
COPY flowtinus.cli/src flowtinus.cli/src
COPY flowtinus.server flowtinus.server

# git sync runs the git binary on a private clone per workspace
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

# the flowtinus command, on a mounted repository: docker run --rm -v "$PWD:/repo" -w /repo <image> flowtinus validate.
# The mount belongs to another user than the image's, which git refuses unless the folder is a safe.directory: only for
# this command, not for the server's own clones.
RUN printf '%s\n' '#!/bin/sh' \
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="*" exec bun /app/flowtinus.cli/src/bin.ts "$@"' \
    > /usr/local/bin/flowtinus && chmod +x /usr/local/bin/flowtinus

# not root: the image's own user
USER bun
EXPOSE 5190

# the api; the supervisor's container runs flowtinus.server/supervisor/main.ts instead
CMD ["bun", "flowtinus.server/api/server.ts"]
