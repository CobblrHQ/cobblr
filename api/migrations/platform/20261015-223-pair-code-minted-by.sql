-- A pair code an admin mints for one named member (#6692), so a worker who
-- has never typed a password signs their phone in by scanning. minted_by is
-- that admin (null for a person's own code from their desk); revoked_at is
-- the admin's Cancel, or a newer code for the same person. Additive: every
-- existing row is a person's own code, never revoked.
alter table auth_pair_codes add column if not exists minted_by uuid references users(id) on delete cascade;
alter table auth_pair_codes add column if not exists revoked_at timestamptz;
