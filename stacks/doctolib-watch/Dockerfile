# Doctolib appointment watcher, headless. watch.py is stdlib-only, so the
# image is just Python plus the script; nothing to pip install.
FROM python:3.13-slim

WORKDIR /app
COPY watch.py .

ENV PYTHONUNBUFFERED=1 \
    DOCTOLIB_HEADLESS=1 \
    DOCTOLIB_CONFIG=/config/config.json \
    DOCTOLIB_STATE=/data/state.json

# One check every 2 minutes; slots at the watched practice have been seen
# vanishing within ~3. watch.py exits 0 on a failed check (it counts the
# failure in state and pushes a warning after enough of them), so a crash
# here would be a bug worth a restart, not a loop to keep alive.
CMD ["sh", "-c", "while :; do python watch.py; sleep 120; done"]
