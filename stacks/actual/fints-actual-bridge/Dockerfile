# Dockerfile for the FinTS bridge daemon. Image bundles:
#   - Python 3.13 + python-fints (the bank protocol)
#   - Node 22 + @actual-app/api (the importer side, bin/import.mjs)
# so a single container can fetch from the bank AND push into Actual on each
# cycle (--import-after).
#
# Build context is this directory; the parent docker-compose.yml builds + runs
# this image as the `fints_daemon_*` services.

# Docker's ECR Public mirror avoids coupling homelab rebuilds to anonymous
# Docker Hub rate limits while retaining the official-library image and tag.
FROM public.ecr.aws/docker/library/python:3.13-slim-bookworm

# Node 22 + a few deps the python-fints stack needs at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps first (cached when source changes).
COPY pyproject.toml README.md ./
COPY src/ ./src/
RUN pip install --no-cache-dir -e .

# Node deps for bin/import.mjs.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Project files (banks.toml is bind-mounted from the host so the user can edit
# it without rebuilds).
COPY bin/ ./bin/

# The named state volume is mounted here at runtime. Keeping the directory in
# the image also makes the CLI's default manifest destination usable in ad-hoc
# container runs.
RUN mkdir -p /state/import-runs

ENV PYTHONUNBUFFERED=1
ENV STATE_DIR=/state

# `command:` in docker-compose.yml supplies the actual fints-daemon flags;
# this CMD is just a safety fallback that prints help.
CMD ["fints-daemon", "--help"]
