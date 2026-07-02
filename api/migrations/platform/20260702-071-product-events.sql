-- Product telemetry (the thesis metrics). One row per HIGH-SIGNAL product
-- event — the "walls" a real user hits (permission_denied, validation_rejected,
-- …) — so walls-hit-per-week and time-to-first-working-app stop being
-- aspirations and become queries (2026-07 architecture audit F2; the strategy
-- docs' north star was uninstrumented).
--
-- DISTINCT from activity_log: that's the append-only AUDIT of mutations
-- (who changed what); this is sparse friction/adoption telemetry. Rows are
-- best-effort (a failed insert never fails the request) and self-pruning
-- (~180-day retention, probabilistic sweep in the tracker).
--
-- Read side: GET /super-admin/product-metrics (operator only).

CREATE TABLE product_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  user_id uuid,
  event text NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX product_events_org_event_idx ON product_events (org_id, event, created_at);
CREATE INDEX product_events_created_idx ON product_events (created_at);
