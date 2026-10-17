-- An optional username an account can sign in with, beside its email (#6910):
-- self-hosted, kiosk and demo installs want "demo", not an address. Stored
-- lower-case, unique, and never containing "@", so a sign-in identifier with
-- an "@" is always an email and one without is always a username.
alter table users add column if not exists username text;
alter table users drop constraint if exists users_username_shape;
alter table users add constraint users_username_shape check (username is null or username ~ '^[a-z0-9][a-z0-9._-]{2,31}$');
create unique index if not exists users_username_key on users (username) where username is not null;
