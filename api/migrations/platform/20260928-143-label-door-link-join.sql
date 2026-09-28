-- The label is the door (#3801).
--
-- A club member who scans an item's label signed out met a sign-in page and
-- nothing else, though the closet's wall QR would have let them in. A join
-- link can now say it may be offered from the workspace's item labels too:
-- off by default, because a label travels with the thing it is stuck to (a
-- lent or sold item carries it out of the room) and the admin decides whether
-- that is a door they want.
alter table workspace_invites add column if not exists offer_on_labels boolean not null default false;

-- A sign-in link remembers where it was asked from and which invite it
-- redeems, so someone without a password can join through a join link by
-- email and land on the item they scanned. Kept server-side: the emailed URL
-- carries only the token.
alter table auth_magic_tokens add column if not exists next_path text;
alter table auth_magic_tokens add column if not exists invite_token text;
alter table auth_magic_tokens add column if not exists display_name text;
