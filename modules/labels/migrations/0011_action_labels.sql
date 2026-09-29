-- Action labels (#3897): a printed QR that opens "Toilet paper 12 -> 11 ·
-- Confirm" in the phone's own camera. One label, one or more buttons; each
-- button is an existing action on a record with the arguments it is pressed
-- with. The scan code itself is a row in cobblr_meta.core_labels_qr_tokens
-- (mode 'action'), so the unauthenticated resolver finds the workspace in one
-- query; this row holds what the label says and does.
--
-- Additive only.

create table if not exists labels_action_labels (
  id          uuid primary key default gen_random_uuid(),
  token_id    uuid not null,
  code        text not null unique,
  title       text not null,
  hint        text,
  buttons     jsonb not null default '[]'::jsonb,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
