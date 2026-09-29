-- People a workspace's records can belong to (#3787).
--
-- "Who owns this" was a text field ("Alex" on one item, "alex" on the next)
-- or a member picker that could not name anyone without an account: the
-- family member, the club member who never signed up, the friend whose drill
-- you are holding. A workspace now keeps one list of people. A member is on
-- it, tied to their account (their name is read from the account, so a
-- rename shows everywhere); anyone else is on it by name. A `person` field
-- stores the list entry's id, so "Alex" is one person across every item, and
-- inviting Alex later ties the same entry to the account they make: every
-- item that was Alex's is still Alex's.
--
-- Names are workspace data. Nothing here is ever sent off the instance.
create table if not exists workspace_people (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  name        text not null default '',
  user_id     uuid references users(id) on delete set null,
  email       text,
  created_at  timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists workspace_people_org_idx on workspace_people(org_id);
create unique index if not exists workspace_people_org_user_uniq on workspace_people(org_id, user_id) where user_id is not null;

-- An invite made FOR someone on the list: accepting it ties that entry to the
-- account, instead of making the member a second, empty person.
alter table workspace_invites add column if not exists person_id uuid references workspace_people(id) on delete set null;

-- `person` joins the field types. Widening a CHECK is additive.
ALTER TABLE module_field_defs DROP CONSTRAINT IF EXISTS module_field_defs_type_check;
ALTER TABLE module_field_defs ADD CONSTRAINT module_field_defs_type_check
  CHECK (type IN ('text', 'number', 'boolean', 'date', 'url', 'computed', 'relation', 'richtext', 'member', 'person'));
