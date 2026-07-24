-- Widen the inbound-email archive (091) to store what the Worker now forwards:
-- the html part (a store receipt is often html-only), the subject, and the
-- Message-ID (to quote the original and thread a reply). Additive + nullable, so
-- existing rows are untouched and older payloads simply have these null.

ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS html_body  text;
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS subject    text;
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS message_id text;
