// Python source for the in-sandbox SQL runner and DB builder.
//
// Kept as TypeScript string constants (not .py files on disk) so the server's
// build output is self-contained — no relative-path fragility between tsx-watch
// and a tsc-compiled dist/. Both scripts use Python stdlib only (sqlite3, json,
// os, sys, time) — no pip installs, no sqlite3 CLI dependency. The
// crucible-dev E2B template ships python3 already.

/** Per-query SQL runner.
 *  Reads SQL from $CRUCIBLE_SQL, opens /workspace/customer.db read-only via
 *  the URI mode=ro switch (so any DML raises OperationalError), executes one
 *  statement, fetches up to RESULT_ROW_CAP rows, and prints a single JSON
 *  document to stdout. SQL errors are caught and reported as data — the
 *  candidate must see their own mistakes. */
export const SQL_RUNNER_PY = `import os, sqlite3, json, time

CAP = 500

sql = os.environ.get("CRUCIBLE_SQL", "")
t0 = time.monotonic()

def emit(payload):
    print(json.dumps(payload, default=str), end="")

try:
    con = sqlite3.connect("file:/workspace/customer.db?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    cur = con.execute(sql)
    columns = [d[0] for d in cur.description] if cur.description else []
    rows = cur.fetchmany(CAP)
    extra = cur.fetchone()
    truncated = extra is not None
    emit({
        "status": "ok",
        "columns": columns,
        "rows": [[r[c] for c in columns] for r in rows],
        "row_count": len(rows),
        "truncated": truncated,
        "duration_ms": int((time.monotonic() - t0) * 1000),
    })
except sqlite3.Error as e:
    emit({
        "status": "error",
        "error": f"{type(e).__name__}: {e}",
        "duration_ms": int((time.monotonic() - t0) * 1000),
    })
finally:
    try:
        con.close()
    except Exception:
        pass
`;

/** One-shot DB builder.
 *  Opens /workspace/customer.db read/write (creating it if missing), then
 *  executescript()'s the two .sql files staged at /tmp/crucible/. Sanity-checks
 *  the row counts of the three core tables and prints a single status line so
 *  the server can confirm the seed worked. Exits non-zero on any error. */
export const BUILD_DB_PY = `import sqlite3, sys, os

SCHEMA = "/tmp/crucible/schema.sql"
SEED   = "/tmp/crucible/seed.sql"
DB     = "/workspace/customer.db"

# Start clean — overwrite any prior DB so re-seeds in the same sandbox are
# deterministic.
try:
    os.remove(DB)
except FileNotFoundError:
    pass

con = sqlite3.connect(DB)
try:
    with open(SCHEMA, "r", encoding="utf-8") as f:
        con.executescript(f.read())
    with open(SEED, "r", encoding="utf-8") as f:
        con.executescript(f.read())
    con.commit()
finally:
    con.close()

# Re-open read-only and sanity-check the row counts. Derive the table list
# from the schema itself (sqlite_master) rather than hardcoding a domain's
# table names — a scenario family with a different schema (e.g. the
# API-integration family's contacts/sync tables vs the DB-triage family's
# customers/payments) must build without editing this shared script.
con = sqlite3.connect("file:%s?mode=ro" % DB, uri=True)
try:
    tables = [r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()]
    if not tables:
        print("build FAILED: no tables created", file=sys.stderr)
        sys.exit(1)
    counts = {}
    for tbl in tables:
        counts[tbl] = con.execute('SELECT COUNT(*) FROM "%s"' % tbl).fetchone()[0]
    print("built ok %s" % counts)
finally:
    con.close()
`;
