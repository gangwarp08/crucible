-- Sample queries used by verify-fde-db-triage.ts (GENERATED — do not edit by hand).
-- Demonstrates the discriminator: naive SUM vs deduped SUM, grouped by month.
-- Output columns are: tag | month | cents.

-- Naive monthly succeeded revenue (what the dashboard shows — includes duplicates).
SELECT 'naive' AS tag, substr(created_at, 1, 7) AS month, SUM(amount_cents) AS cents
FROM payments
WHERE status = 'succeeded'
  AND substr(created_at, 1, 7) IN ('2026-03', '2026-04', '2026-05')
GROUP BY substr(created_at, 1, 7)
ORDER BY month;

-- Corrected monthly succeeded revenue: dedup by external_payment_id (keep MIN id),
-- then filter to succeeded only.
WITH dedup AS (
  SELECT MIN(id) AS keep_id
  FROM payments
  WHERE status = 'succeeded'
  GROUP BY external_payment_id
)
SELECT 'corrected' AS tag, substr(p.created_at, 1, 7) AS month, SUM(p.amount_cents) AS cents
FROM payments p
JOIN dedup d ON d.keep_id = p.id
WHERE substr(p.created_at, 1, 7) IN ('2026-03', '2026-04', '2026-05')
GROUP BY substr(p.created_at, 1, 7)
ORDER BY month;

-- Proof: external_payment_ids that appear more than once (the bug fingerprint).
-- These are confined to the bug months (Apr + May 2026).
SELECT 'duplicates' AS tag, external_payment_id, COUNT(*) AS n
FROM payments
WHERE status = 'succeeded'
GROUP BY external_payment_id
HAVING COUNT(*) > 1
ORDER BY external_payment_id
LIMIT 10;
