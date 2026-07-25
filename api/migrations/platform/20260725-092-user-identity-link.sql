-- Slice 3 (central identity federation): link each local user to its global identity.
-- Additive + nullable — no behaviour change until the central identity is wired
-- (IDENTITY_URL set). `identity_id` is this deployment's copy of the global id that the
-- identity service issued during backfill; a verified central token's `sub` maps to the
-- local user through this column. UNIQUE = one local user per global identity on THIS
-- deployment (org_memberships stay per-deployment, now reachable via the global id).
alter table users add column if not exists identity_id uuid unique;
