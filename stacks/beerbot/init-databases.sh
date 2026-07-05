#!/bin/bash
# Creates the extra databases in POSTGRES_MULTIPLE_DATABASES (comma-separated) on
# first init of a fresh volume. Copy of the same script in the BeerBot repo —
# vendored here so this stack's compose is self-contained (Komodo clones this repo).
set -e
set -u

if [ -n "${POSTGRES_MULTIPLE_DATABASES:-}" ]; then
    echo "Creating additional databases: $POSTGRES_MULTIPLE_DATABASES"
    for db in $(echo "$POSTGRES_MULTIPLE_DATABASES" | tr ',' ' '); do
        echo "  → $db"
        psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
            SELECT 'CREATE DATABASE $db'
            WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$db')\gexec
EOSQL
    done
fi
