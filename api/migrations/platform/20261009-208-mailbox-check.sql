-- "Check my mailbox" (#5462): a dry run of the order-email classifier over a
-- person's whole mailbox history, which files nothing. The owner reviews it
-- against fifteen years of his own orders before any live filing turns on.
--
-- A check walks Gmail's candidate query page by page (page_token, so a
-- restart resumes where it was) and keeps, per message, only what the review
-- shows: the Gmail id, when, the sender, the subject, how it was decided and
-- what it would file. No body is kept. person_verdict is the person's own
-- "is / isn't an order" from the review; mailbox_sender_verdicts remembers it
-- per sender, so the rules learn and a "not an order" store is not re-read.
-- Additive.

CREATE TABLE IF NOT EXISTS mailbox_checks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id uuid NOT NULL REFERENCES user_credentials(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query         text NOT NULL,
  -- 'running' | 'done' | 'stopped' | 'failed'
  status        text NOT NULL DEFAULT 'running',
  page_token    text,
  pages         integer NOT NULL DEFAULT 0,
  seen          integer NOT NULL DEFAULT 0,
  last_error    text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX IF NOT EXISTS mailbox_checks_running_idx ON mailbox_checks (status) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS mailbox_checks_credential_idx ON mailbox_checks (credential_id, started_at DESC);

CREATE TABLE IF NOT EXISTS mailbox_check_items (
  check_id        uuid NOT NULL REFERENCES mailbox_checks(id) ON DELETE CASCADE,
  gmail_id        text NOT NULL,
  received_at     timestamptz,
  sender          text,
  sender_domain   text,
  subject         text,
  purchases_label boolean NOT NULL DEFAULT false,
  verdict         text NOT NULL,
  decided_by      text NOT NULL,
  strength        text,
  platform        text,
  found           jsonb NOT NULL DEFAULT '{}'::jsonb,
  person_verdict  text,
  PRIMARY KEY (check_id, gmail_id)
);
CREATE INDEX IF NOT EXISTS mailbox_check_items_sender_idx ON mailbox_check_items (check_id, sender_domain);

CREATE TABLE IF NOT EXISTS mailbox_sender_verdicts (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_domain text NOT NULL,
  -- 'order' | 'not-order'
  verdict       text NOT NULL,
  set_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sender_domain)
);
