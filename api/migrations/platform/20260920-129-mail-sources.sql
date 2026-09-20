-- A mailbox a person connects so Cobblr reads their store and carrier mail
-- itself (the Gmail door of receipts-by-email). The grant lives in
-- user_credentials like any personal connection; this is the SYNC STATE
-- beside it: where the read is up to, when it last ran, and why it stopped.
-- Additive: a nullable pair on the archive says which mailbox a message was
-- read from, so the same Gmail message is never read twice and a replay can
-- re-fetch it by id instead of storing its body.

CREATE TABLE IF NOT EXISTS mail_source_state (
  credential_id  uuid PRIMARY KEY REFERENCES user_credentials(id) ON DELETE CASCADE,
  -- Messages before this instant were read; the next sync asks from a day
  -- earlier and dedups on the archive, so a clock skew loses nothing.
  cursor_at      timestamptz,
  last_synced_at timestamptz,
  last_error     text,
  -- 'ok' | 'needs_reconnect' (the grant died at the issuer) | 'failing'
  status         text NOT NULL DEFAULT 'ok',
  messages_seen  integer NOT NULL DEFAULT 0,
  -- The one card a stopped source sends, so a poll every five minutes is
  -- never a card every five minutes.
  stopped_notified_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS source     text;
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS source_ref text;
CREATE INDEX IF NOT EXISTS inbound_emails_source_ref_idx
  ON inbound_emails (source, source_ref) WHERE source IS NOT NULL;
