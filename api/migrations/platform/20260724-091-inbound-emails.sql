-- Durable archive of every inbound email BEFORE it is processed.
--
-- The receipts+ / reply+ inbound seam used to parse-then-discard: a message the
-- app couldn't handle (a body-only receipt, a transient parser failure) was
-- gone, with the only copy left in the sender's mailbox. A user sends an email
-- ONCE; if we fail to act on it, reprocessing it is OUR job, not theirs. So we
-- persist the raw payload on arrival and record the outcome, making any inbound
-- message replayable from the backend.
--
-- Lives in cobblr_meta because the dispatcher is platform-level (it resolves the
-- tenant from the To token; org_id/user_id are filled in once resolved, and are
-- null for a message we couldn't attribute).

CREATE TABLE IF NOT EXISTS inbound_emails (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at    timestamptz NOT NULL DEFAULT now(),
  to_addr        text,
  from_email     text,
  text_body      text,
  -- [{ filename, content_type, content_base64 }] — the raw bytes, so a reprocess
  -- runs the identical pipeline. Capped on write (see inbound-archive.ts).
  attachments    jsonb NOT NULL DEFAULT '[]'::jsonb,
  handler        text,          -- 'receipt' | 'feedback' | null (unrouted)
  org_id         uuid,          -- resolved tenant, null until/unless attributed
  user_id        uuid,          -- resolved user,   null until/unless attributed
  outcome        jsonb,         -- { item_count, reason, ... } from the handler
  processed_at   timestamptz,   -- set once a dispatch attempt completes
  attempts       integer NOT NULL DEFAULT 0
);

-- The reprocess work-list: messages that landed nothing (never processed, or
-- processed with zero items). Partial index keeps it tiny — the happy path
-- (items created) never sits in here.
CREATE INDEX IF NOT EXISTS inbound_emails_needs_reprocess_idx
  ON inbound_emails (received_at)
  WHERE processed_at IS NULL OR COALESCE(outcome->>'item_count', '0') = '0';
