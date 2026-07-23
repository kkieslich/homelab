# Build context is stacks/actual/ (so we can copy ./cli, ./db-sync, and the
# shared fints-actual-bridge/src/importer module).
# better-sqlite3 needs build-essential on first install if no prebuilt binary
# exists for the target arch; node:22-bookworm-slim ships a working toolchain.
FROM node:22-bookworm-slim

WORKDIR /app

# cli/ holds the analysis libs we re-use (subscription detector etc).
COPY cli/package.json ./cli/
RUN cd cli && npm install --omit=dev --no-audit --no-fund

# db-sync's deps (better-sqlite3 + @actual-app/api).
COPY db-sync/package.json ./db-sync/
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && cd db-sync && npm install --omit=dev --no-audit --no-fund \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY cli/      ./cli/
COPY db-sync/  ./db-sync/
# Shared text/date identity module (no deps of its own); laid out as a
# sibling of cli/ and db-sync/ so sync.mjs's ../../fints-actual-bridge/...
# import and cli's ../../../fints-actual-bridge/... import both resolve.
COPY fints-actual-bridge/src ./fints-actual-bridge/src

ENV NODE_ENV=production
ENV ACTUAL_DATA_DIR=/data
ENV ACTUAL_DB_PATH=/db/actual.sqlite

WORKDIR /app/db-sync
CMD ["node", "src/index.mjs"]
