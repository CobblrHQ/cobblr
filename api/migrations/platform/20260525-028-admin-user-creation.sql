-- Admin-creates-user flow.
--
-- Two columns on `users` to support no-email onboarding:
--
--   must_reset_password
--     true when an admin minted the account with a temp password.
--     Login still succeeds, but the login response carries the flag;
--     the web client redirects to /me/force-password-reset until the
--     user picks their own password.
--
--   created_by
--     uuid of the admin who minted the account. null when the user
--     self-registered via /signup. Lets us show "created by Alice
--     on 2026-05-25" in the admin user-list UI + activity log.

alter table users
  add column if not exists must_reset_password boolean not null default false;

alter table users
  add column if not exists created_by uuid references users(id) on delete set null;

create index if not exists users_created_by_idx
  on users(created_by)
  where created_by is not null;
