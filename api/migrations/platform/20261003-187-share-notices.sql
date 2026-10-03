-- What a share has to tell its people, gathered so it is told once
-- (#4627 §3, docs/design-decisions/share-spaces.md §10). Additive.
--
-- One row per thing that happened (an edit suggested or applied, on the
-- owner's side; an edit accepted or rejected, on the friend's). A pass sends
-- each link's unsent rows of one kind as ONE notification a little after the
-- last of them ("Vince suggested 6 edits on 3 things"), never one per edit.
create table if not exists share_notices (
  id bigserial primary key,
  link_id uuid not null references share_links(id) on delete cascade,
  kind text not null,
  title text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists share_notices_unsent on share_notices (link_id, kind) where sent_at is null;
