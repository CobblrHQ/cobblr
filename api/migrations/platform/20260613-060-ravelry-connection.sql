-- Ravelry connection (feedback a713b84c) — a user's READ-ONLY Ravelry API
-- credentials so we can import their stash + projects into the Yarn bundle.
-- User-scoped (a knitter's Ravelry account is theirs, not a workspace's), in
-- cobblr_meta. credentials_encrypted: AES-256-GCM (db/crypto.ts) of a JSON
-- object { access_key, personal_key } (Ravelry "personal" Basic-Auth creds).
--
-- ravelry_imports: the idempotency map — for each imported Ravelry object we
-- record which tenant entity it became, keyed by (org, type, ravelry_id), so a
-- re-import UPDATES instead of duplicating (the entities themselves live in the
-- per-org tenant DB and have no external_id column, so the map lives here).
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS ravelry_imports;
--   DROP TABLE IF EXISTS ravelry_connections;

create table if not exists ravelry_connections (
  user_id               uuid primary key references users(id) on delete cascade,
  username              text,
  credentials_encrypted text not null,
  verified_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table if not exists ravelry_imports (
  org_id      uuid not null,
  -- 'stash' | 'project'
  kind        text not null,
  ravelry_id  text not null,
  -- the instance the entity was created in (e.g. 'yarn', 'designs')
  instance    text not null,
  -- the created tenant entity's id (no cross-db FK — just the uuid)
  entity_id   uuid not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (org_id, kind, ravelry_id)
);
