-- Sample queries proving each Tier 1.5 issue is findable (GENERATED).
-- Output columns vary per query; tag column identifies the issue.

-- ─── Issue 1 (HIGH) — Revenue double-count ─────────────────────────────────
-- Naive monthly succeeded revenue (what the dashboard shows — includes duplicates).
SELECT 'issue1_naive' AS tag, substr(created_at, 1, 7) AS month, SUM(amount_cents) AS cents
FROM payments
WHERE status = 'succeeded'
  AND substr(created_at, 1, 7) IN ('2026-03', '2026-04', '2026-05')
GROUP BY substr(created_at, 1, 7)
ORDER BY month;

-- Corrected monthly succeeded revenue: dedup by external_payment_id (keep MIN id).
WITH dedup AS (
  SELECT MIN(id) AS keep_id
  FROM payments
  WHERE status = 'succeeded'
  GROUP BY external_payment_id
)
SELECT 'issue1_corrected' AS tag, substr(p.created_at, 1, 7) AS month, SUM(p.amount_cents) AS cents
FROM payments p
JOIN dedup d ON d.keep_id = p.id
WHERE substr(p.created_at, 1, 7) IN ('2026-03', '2026-04', '2026-05')
GROUP BY substr(p.created_at, 1, 7)
ORDER BY month;

-- Duplicate fingerprint: external_payment_ids appearing more than once.
SELECT 'issue1_duplicates' AS tag, external_payment_id, COUNT(*) AS n
FROM payments
WHERE status = 'succeeded'
GROUP BY external_payment_id
HAVING COUNT(*) > 1
ORDER BY external_payment_id
LIMIT 10;

-- ─── Issue 2 (HIGH) — Churn paused miscount ────────────────────────────────
-- Status distribution: three states, not two.
SELECT 'issue2_status_split' AS tag, status, COUNT(*) AS n
FROM subscriptions
GROUP BY status
ORDER BY status;

-- Naive churn (treats paused as churned) vs true churn (churned only).
SELECT 'issue2_naive_churn' AS tag,
  ROUND(100.0 * SUM(CASE WHEN status IN ('churned','paused') THEN 1 ELSE 0 END) / COUNT(*), 2) AS pct
FROM subscriptions;

SELECT 'issue2_true_churn' AS tag,
  ROUND(100.0 * SUM(CASE WHEN status = 'churned' THEN 1 ELSE 0 END) / COUNT(*), 2) AS pct
FROM subscriptions;

-- Proof paused subs are alive (recent payments).
SELECT 'issue2_paused_recent_payments' AS tag, COUNT(*) AS n
FROM subscriptions s
JOIN payments p ON p.subscription_id = s.id
WHERE s.status = 'paused'
  AND p.status = 'succeeded'
  AND substr(p.created_at, 1, 7) IN ('2026-04', '2026-05');

-- ─── Issue 3 (LOW) — Cosmetic customer-count inflation ─────────────────────
-- Test/internal customer count (the trap: inflates COUNT(*) but $0 revenue).
SELECT 'issue3_test_customer_count' AS tag, COUNT(*) AS n
FROM customers
WHERE name LIKE 'Test\_%' ESCAPE '\' OR name LIKE 'Internal Sandbox%';

-- Total revenue attributable to those customers (should be 0).
SELECT 'issue3_test_customer_revenue' AS tag, COALESCE(SUM(p.amount_cents), 0) AS cents
FROM customers c
LEFT JOIN subscriptions s ON s.customer_id = c.id
LEFT JOIN payments p ON p.subscription_id = s.id AND p.status = 'succeeded'
WHERE c.name LIKE 'Test\_%' ESCAPE '\' OR c.name LIKE 'Internal Sandbox%';
