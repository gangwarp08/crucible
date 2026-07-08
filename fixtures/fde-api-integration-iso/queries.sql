-- Discriminator queries for fde-api-integration-iso-v1 (GENERATED — do not edit by hand).
-- Mirrors the strong-playthrough SQL in apps/server/scripts/family2-content.ts.

-- [1] HTTP status distribution — surfaces the 401/429 red herring.
SELECT status_code, COUNT(*) AS n
FROM api_requests
GROUP BY status_code
ORDER BY n DESC;

-- [2] The gap: provider count vs distinct local count.
SELECT
  (SELECT COUNT(*) FROM provider_contacts) AS provider_n,
  (SELECT COUNT(DISTINCT external_id) FROM local_contacts) AS local_n,
  (SELECT COUNT(*) FROM provider_contacts)
    - (SELECT COUNT(DISTINCT external_id) FROM local_contacts) AS missing_n;

-- [3] Characterize the missing records (they cluster at cursor-page boundaries).
SELECT p.external_id, p.updated_at
FROM provider_contacts p
LEFT JOIN local_contacts l ON l.external_id = p.external_id
WHERE l.external_id IS NULL
ORDER BY p.updated_at
LIMIT 25;

-- [4] Pagination fingerprint: a retried request re-used a stale cursor, so a
-- page was fetched twice (and its successor skipped).
SELECT cursor, COUNT(*) AS n
FROM api_requests
WHERE endpoint LIKE '%/contacts%' AND status_code = 200
GROUP BY cursor
HAVING COUNT(*) > 1
ORDER BY n DESC
LIMIT 10;

-- [5] Retry paths (which requests were retries, of what).
SELECT retry_of, COUNT(*) AS n
FROM api_requests
WHERE retry_of IS NOT NULL
GROUP BY retry_of
ORDER BY n DESC
LIMIT 10;
