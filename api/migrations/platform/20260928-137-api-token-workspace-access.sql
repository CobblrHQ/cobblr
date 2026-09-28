-- A personal API token can be held to ONE workspace and to an ACCESS level.
--
-- Until now every personal token was full access to every workspace its owner
-- belongs to: the mint dialog had no other choice. A token handed to an AI
-- assistant or a script for one job carried the whole account.
--
--   org_id  the one workspace the token may reach; NULL = every workspace
--           (the only behaviour before this column).
--   access  'look'   = read only;
--           'change' = read, and change records and run actions, never the
--                      workspace's settings, members or credentials;
--           'full'   = everything the owner can do;
--           NULL     = full, as every token minted before this was.
--
-- Additive: an existing token keeps NULL in both and works exactly as before.
-- The rule that reads them is api/src/auth/token-access.ts.

alter table api_tokens add column if not exists org_id uuid references orgs(id) on delete cascade;
alter table api_tokens add column if not exists access text;
alter table api_tokens drop constraint if exists api_tokens_access_check;
alter table api_tokens add constraint api_tokens_access_check check (access is null or access in ('look', 'change', 'full'));
