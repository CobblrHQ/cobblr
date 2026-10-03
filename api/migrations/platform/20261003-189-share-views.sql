-- View as: the owner seeing the share space the way the friend sees it
-- (#4627 §5a, docs/design-decisions/share-spaces.md §14). Additive.
--
-- One row per grant, on the side where the share space lives: who asked
-- (by name, over the signed link), whose eyes it lends (the share space's own
-- person), when it ends, and how much it was used. Revocable (ended_at), and
-- what the friend's Sharing page reads to say "Viewed by Sam".
create table if not exists share_view_sessions (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references share_links(id) on delete cascade,
  org_id uuid not null references orgs(id) on delete cascade,
  target_user_id uuid not null references users(id) on delete cascade,
  viewer_name text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  request_count integer not null default 0
);
create index if not exists share_view_sessions_link on share_view_sessions (link_id, created_at desc);
