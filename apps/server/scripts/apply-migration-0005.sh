#!/usr/bin/env bash
# Apply migration 0005 (merge_scenario_state RPC) via psql against the live
# Supabase Postgres URL. The Supabase CLI is not installed locally; this
# script is the same workflow used in prior slices' migration applies.
#
# Requires SUPABASE_DB_URL in .env. Idempotent (CREATE OR REPLACE).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"

if [ -z "${SUPABASE_DB_URL:-}" ] && [ -f "$REPO_ROOT/.env" ]; then
  # Don't `source` the .env directly — values can contain shell metachars (#,
  # !, $, etc.) which the parser mangles. Read the literal value via python.
  SUPABASE_DB_URL="$(python3 - "$REPO_ROOT/.env" <<'PY'
import re, sys
key = "SUPABASE_DB_URL"
with open(sys.argv[1]) as f:
    for line in f:
        m = re.match(rf"^{key}=(.*)$", line.rstrip("\n"))
        if m:
            v = m.group(1)
            # Strip optional surrounding single/double quotes.
            if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                v = v[1:-1]
            print(v); break
PY
  )"
  export SUPABASE_DB_URL
fi
: "${SUPABASE_DB_URL:?SUPABASE_DB_URL not set in env}"

PSQL_BIN="${PSQL_BIN:-psql}"
if ! command -v "$PSQL_BIN" >/dev/null 2>&1; then
  # macOS Homebrew install path
  if [ -x /opt/homebrew/opt/libpq/bin/psql ]; then
    PSQL_BIN=/opt/homebrew/opt/libpq/bin/psql
  else
    echo "psql not found on PATH; install it (brew install libpq) or set PSQL_BIN" >&2
    exit 1
  fi
fi

MIGRATION="$REPO_ROOT/supabase/migrations/0005_merge_scenario_state_rpc.sql"

# Convert the postgresql:// URL into libpq keyword=value form so passwords
# containing #/!/$/etc. don't need to be URL-encoded in the .env. libpq's
# keyword form treats the password as a literal string between single quotes.
CONN_STR="$(python3 - <<'PY'
import os
# Always parse manually: urlparse trips over unencoded password chars (#, !, :).
# Split on '://', then split netloc on the LAST '@' (so '@' in password is
# safe), then split path off after the host.
raw = os.environ["SUPABASE_DB_URL"]
scheme, rest = raw.split("://", 1)
creds_and_host, _, dbname = rest.partition("/")
creds, _, hostport = creds_and_host.rpartition("@")
user, _, password = creds.partition(":")
host, _, port = hostport.partition(":")
if not port:
    port = "5432"
if not dbname:
    dbname = "postgres"

def esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace("'", "\\'")

print(
    f"host='{esc(host)}' port='{port}' user='{esc(user)}' "
    f"password='{esc(password)}' dbname='{esc(dbname)}' sslmode=require"
)
PY
)"

echo "applying $MIGRATION via $PSQL_BIN ..."
"$PSQL_BIN" "$CONN_STR" -v ON_ERROR_STOP=1 -f "$MIGRATION"
echo "OK"
