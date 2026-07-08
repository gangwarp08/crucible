# GOING-LIVE — activating the dormant builds

*The operator runbook for turning on what was deliberately built OFF: the
second scenario family (`fde-api-integration`, dormant by data) and
proctoring v2 (identity + webcam presence, dormant by flag). Context:
`docs/ARCHITECTURE-REPORT.md` §13.5–13.7.*

Both activations are **manual, checkpointed, and independent** — neither is a
deploy side-effect, and nothing in CI or the server flips them. Run each
section top to bottom; every step is copy-paste where possible.

---

## Standing ops reminders (apply to both runbooks)

- **Never deploy — or apply migrations — during a live candidate session.**
  A server restart loses in-memory timers and drops WebSockets (the reaper
  recovers, but don't make it). Check `/api/review/sessions` for `active`
  sessions first.
- **Migrations apply in filename order.** 0023 must land before (or without)
  0024 only in the sense that each runbook applies its own file; never apply
  a later migration while an earlier one is missing.
- **`ORG_ADMIN_KEY` rotation lives on Railway** — it's an env var on the
  server service, not a minted key. Rotate it by editing the Railway
  variable; you'll need it (or a minted admin org key) for the org-guarded
  steps below.
- Both dormant features are **fail-closed**: if any step below goes wrong,
  the system stays in (or degrades to) its current behavior. Stop, fix,
  re-run — nothing candidate-facing breaks mid-runbook.

## Applying a migration (the pooler method)

The direct Supabase DB host (`db.<ref>.supabase.co`) is **IPv6-only** — from
most operator machines `psql` can't reach it. Apply migrations through the
**session pooler** host instead (`aws-1-us-west-2.pooler.supabase.com`,
port 5432), where the username is `<user>.<project-ref>`.

From the repo root (creds come from `SUPABASE_DB_URL` in `.env` — the
password may contain `@`, so strip from the **last** `@`):

```bash
DB_URL=$(grep '^SUPABASE_DB_URL=' .env | cut -d= -f2-)
CREDS=${DB_URL#postgresql://}; CREDS=${CREDS%@*}      # user:pass (pass may contain @)
DB_USER=${CREDS%%:*}
DB_PASS=${CREDS#*:}
DB_REF=$(printf '%s' "$DB_URL" | sed -E 's#.*@db\.([a-z0-9]+)\.supabase\.co.*#\1#')

PGPASSWORD="$DB_PASS" psql \
  -h aws-1-us-west-2.pooler.supabase.com -p 5432 \
  -U "${DB_USER}.${DB_REF}" -d postgres \
  -f supabase/migrations/<MIGRATION_FILE>.sql
```

Both 0023 and 0024 are idempotent (IF NOT EXISTS / ON CONFLICT upserts) —
safe to re-run if a step is interrupted.

---

## A. Activate family 2 (`fde-api-integration`)

**When:** after *cohort 1 closes* — all cohort-1 session links consumed or
expired **and** every cohort-1 session has a complete evaluation. Confirm in
the review dashboard before starting.

### A.1 Apply migration 0023

```bash
PGPASSWORD="$DB_PASS" psql \
  -h aws-1-us-west-2.pooler.supabase.com -p 5432 \
  -U "${DB_USER}.${DB_REF}" -d postgres \
  -f supabase/migrations/0023_family2_api_integration.sql
```

This adds `scenarios.catalog_visible` (default `true` — family 1 keeps
listing exactly as before) and seeds the three family-2 members with
`catalog_visible = false`. **Nothing candidate-facing changes at this step**:
the family is in the DB but hidden.

Sanity check:

```sql
SELECT slug, catalog_visible FROM scenarios
WHERE family_id = 'fde-api-integration';
-- expect 3 rows, all catalog_visible = false
```

### A.2 Run the calibration verifiers

Cheap/deterministic first (no sandbox, no judge — these were skipping while
the family was unseeded and must now PASS):

```bash
pnpm --filter @crucible/server exec tsx scripts/verify-family2-content.ts
pnpm --filter @crucible/server exec tsx scripts/verify-family2-units.ts
pnpm --filter @crucible/server exec tsx scripts/verify-family2-dormant.ts
pnpm --filter @crucible/server exec tsx scripts/verify-family1-drift-inert.ts
pnpm --filter @crucible/server exec tsx scripts/verify-cross-family-scale.ts
```

Then the two **infra-gated** calibration gates. ⚠ These run scripted
playthroughs end to end through the real harness — they **boot E2B sandboxes
and call the LLM judge, spending real budget** (respect
`GLOBAL_DAILY_SPEND_CEILING_USD`; a live server at `SERVER_URL` is required):

```bash
pnpm --filter @crucible/server exec tsx scripts/verify-family2-discrimination.ts
pnpm --filter @crucible/server exec tsx scripts/verify-family2-isomorph.ts
```

**All green is the gate.** Any failure → stop here; the family stays hidden
and nothing has changed for candidates.

Also on the pre-activation checklist (from the final PR #28 review): tighten
the family-2 fork detector's decline handling — `PS_FORK2_SHORTCUT_MARKERS`
includes the bare word "workaround" and the negation window only scans 60
chars backwards, so a deliverable phrased "the workaround Sam proposed was
declined" can register as `shortcut_taken`. Bounded impact (Stage-B LLM
grading is primary), but fix + re-run `verify-family2-units.ts` before real
candidates see the family.

### A.3 Flip the visibility switch

```sql
UPDATE scenarios SET catalog_visible = true
WHERE family_id = 'fde-api-integration';
```

(Same `psql` connection as A.1, or the Supabase SQL editor.)

### A.4 Optional — allow band routing to the family

Difficulty-band routing (`services/difficulty-routing.ts`) routes within a
scenario family at session creation, so once the family is visible,
session links minted **for a family-2 scenario** with a `difficulty_band`
route among its members automatically. Enabling band routing to family 2 is
simply: start minting session links against `fde-api-integration` with a
band. No flag to flip — just don't mint banded family-2 links until you
intend to.

### A.5 Post-flip smoke

1. **Catalog:** `GET /api/scenarios` (or open `/scenarios`) — the family-2
   scenarios now list; family 1 unchanged.
2. **Session-link mint:** in `/review`, the SessionLinkMintPanel offers the
   family-2 scenario; mint a link and confirm `/start/fde-api-integration?link=…`
   reaches the start screen.
3. Optionally run one internal end-to-end session before handing links to a
   real cohort.

### Separately documented — the family-1 fork retrofit

Retrofitting the native product-sense fork into `fde-db-triage` is **its own,
later versioning event** (scenario-version bump + anchor re-check + drift
run). It is *not* part of family-2 activation and must not ride along with
this flip.

---

## B. Activate proctoring v2 (per org)

**When:** per org, on request — and **never for trusted pilot orgs**.

### B.0 PREREQUISITE — counsel sign-off (operational gate)

Biometric + government-ID capture is BIPA / GDPR-class data. Before any org
gets the flag:

- Counsel signs off the **consent text** — `CONSENT_TEXT` /
  `CONSENT_TEXT_VERSION` (currently `1`) in
  `apps/server/src/services/proctoring-v2.ts` — for the target jurisdiction.
  If the text changes, bump `CONSENT_TEXT_VERSION` in the same file and
  deploy before proceeding.
- Counsel signs off the **data handling**: raw images processed in memory
  only and never persisted; `identity_checks` stores derived results only;
  org-scoped hard deletion via the identity-delete endpoint; `identity.*`
  events retained (see B.5).

This gate is **not enforceable in code** — enabling the flag without it is an
operational-policy violation. Do not proceed without written sign-off.

### B.1 Apply migration 0024

Same pooler method as above:

```bash
PGPASSWORD="$DB_PASS" psql \
  -h aws-1-us-west-2.pooler.supabase.com -p 5432 \
  -U "${DB_USER}.${DB_REF}" -d postgres \
  -f supabase/migrations/0024_proctoring_v2.sql
```

Creates `identity_checks` (derived data only — no column can hold image
bytes; RLS deny-all). Still dormant after this step: every org's flag is
absent = false.

### B.2 Run the proctoring-v2 verifiers (now unskipped)

These were skipping cleanly pre-0024 and must now PASS (infra-light —
Supabase + in-process Fastify, no sandbox, no real LLM):

```bash
pnpm --filter @crucible/server exec tsx scripts/verify-proctoring-v2-flag.ts
pnpm --filter @crucible/server exec tsx scripts/verify-identity-verify.ts
pnpm --filter @crucible/server exec tsx scripts/verify-biometric-retention.ts
```

They prove, in order: the dormancy contract (flag off → 403 + zero capture;
decline → downgrade), derived-only storage (the raw images appear nowhere),
and org-scoped hard deletion.

### B.3 Enable for ONE org

```sql
UPDATE orgs
SET settings = settings || '{"proctoring_v2_enabled": true}'::jsonb
WHERE slug = '<org-slug>';
```

Only the literal boolean `true` enables it; every other org stays on v1.
To disable again:

```sql
UPDATE orgs
SET settings = settings || '{"proctoring_v2_enabled": false}'::jsonb
WHERE slug = '<org-slug>';
```

### B.4 Smoke (scoped to that org)

1. **Consent screen appears for that org's links only:** mint a session link
   for the enabled org, open `/start/<slug>?link=…` — the consent gate +
   identity capture render. Open a link from any *other* org — the ordinary
   v1 start screen, no consent prompt, no webcam permission request.
2. **Decline downgrades:** decline the consent — the session proceeds
   normally on v1 passive proctoring (no webcam, no ID capture), and
   `POST /sessions/:id/identity-verify` refuses with 403.
3. **Delete endpoint works:** for a test session with an identity row,
   `POST /api/review/sessions/:id/identity-delete` (with the org's
   `X-Org-Key`, or `ORG_ADMIN_KEY`) returns `{ deleted: 1 }`, and the
   suspicion route's `identity` block reads null afterward.

### B.5 Policy notes (recorded decisions)

- **Never enable for trusted pilot orgs.** The pilot cohort runs on v1
  passive proctoring; v2 is for orgs that explicitly require identity
  assurance and have accepted the consent flow.
- **Deletion covers `identity_checks`; `identity.*` events are retained by
  design.** Recorded decision: after a biometric deletion, the
  `identity.consent` / `identity.verified` events on the append-only stream
  are NOT scrubbed — they hold only the consent decision and derived
  confidence/verified flags (no imagery), and the append-only telemetry rule
  stands. Raw frames were never stored, so hard-deleting the
  `identity_checks` rows removes everything biometric-derived outside the
  event stream.
