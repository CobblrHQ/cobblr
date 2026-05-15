-- Extend activity_log so every entry records HOW the action was
-- authenticated, not just who. This is the difference between
-- knowing "the author triggered X" and "the author's `claude-on-macbook` token
-- triggered X" — important for AI / CLI / automation auditability.
--
-- auth_method:
--   'session'   — browser session JWT (UI action by a human)
--   'api_token' — long-lived cbt_* token (CLI / AI / agent)
--   'system'    — emitted internally (wires, subscribers, boot tasks)
--                 — user_id may be null in this case
--
-- api_token_id points back at api_tokens(id) so the UI can show
-- "via 'claude-on-macbook'" alongside the user.

alter table activity_log
  add column if not exists auth_method text
    check (auth_method in ('session', 'api_token', 'system')),
  add column if not exists api_token_id uuid references api_tokens(id) on delete set null;

-- Pre-existing rows have no auth context — backfill them as 'system'
-- so the column can be made not-null going forward.
update activity_log set auth_method = 'system' where auth_method is null;

alter table activity_log alter column auth_method set not null;
alter table activity_log alter column auth_method set default 'system';

create index activity_log_auth_idx on activity_log(auth_method);
create index activity_log_token_idx on activity_log(api_token_id)
  where api_token_id is not null;
