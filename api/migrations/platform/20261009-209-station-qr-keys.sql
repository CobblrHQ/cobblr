-- A station's kitchen QR (#5353): a printed label that lets anyone holding
-- it press a station's chosen actions from their own phone, without an
-- account. Only the key's hash is kept; printing a new label replaces the
-- row, and the tokens claimed with the old key are revoked with it. One row
-- per station; none while the owner has not turned the QR on. Additive.
create table if not exists station_qr_keys (
  org_id uuid not null references orgs(id) on delete cascade,
  address text not null,
  key_hash text not null,
  enabled_by uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (org_id, address)
);
