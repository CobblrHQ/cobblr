-- A public page: the records a scope selects, shown to anyone holding one of
-- its links (#4502, docs/design-decisions/share-scope.md). Additive.
--
-- The scope and the visibility are the SAME definitions a share uses
-- (@cobblr/platform-contract/share-scope), never a copy of their rules. A
-- page's links are surfaces (scope_type 'page', scope_id = the page), each
-- with its own token, label, expiry and visibility override, so one page can
-- have a bare link and a detailed one.
create table if not exists core_public_surfaces_pages (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  scope       jsonb not null default '{}'::jsonb,
  visibility  jsonb not null default '{}'::jsonb,
  layout      text not null default 'gallery',
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
