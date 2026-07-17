-- labels 0.6.0 — absorb the former core-labels-qr module's tenant tables.
--
-- Existing workspaces (tables created by core-labels-qr 0001-0003): RENAME to
-- the labels_ prefix and leave updatable single-table VIEWS at the old names,
-- so an old api image still serving during a blue-green rollout keeps working
-- (reads + plain INSERTs go through the views; the settings PUT's
-- INSERT..ON CONFLICT is the one op views can't take — rare admin write,
-- ~60s window, retry succeeds). The views drop in a later release.
--
-- Fresh workspaces (labels enabled after the merge): create the labels_
-- tables directly.
--
-- The meta-side token table keeps its historical name (core_labels_qr_tokens
-- in cobblr_meta): printed /qr/<token> URLs and the immutable platform
-- migration both outlive module identity.

create extension if not exists "pgcrypto";

do $$
begin
  if to_regclass('core_labels_qr_scans') is not null
     and to_regclass('labels_qr_scans') is null then
    alter table core_labels_qr_scans rename to labels_qr_scans;
    alter index if exists core_labels_qr_scans_token_idx
      rename to labels_qr_scans_token_idx;
    create view core_labels_qr_scans as select * from labels_qr_scans;
  elsif to_regclass('labels_qr_scans') is null then
    create table labels_qr_scans (
      id           uuid primary key default gen_random_uuid(),
      token_id     uuid not null,
      scanned_at   timestamptz not null default now(),
      ua_hint      text,
      referer      text,
      action_invoked text,
      action_ok    boolean
    );
    create index labels_qr_scans_token_idx
      on labels_qr_scans(token_id, scanned_at desc);
  end if;

  if to_regclass('core_labels_qr_settings') is not null
     and to_regclass('labels_qr_settings') is null then
    alter table core_labels_qr_settings rename to labels_qr_settings;
    create view core_labels_qr_settings as select * from labels_qr_settings;
  elsif to_regclass('labels_qr_settings') is null then
    create table labels_qr_settings (
      id          integer primary key default 1 check (id = 1),
      token_style text not null default 'descriptive'
                  check (token_style in ('descriptive', 'opaque')),
      label_base_url text,
      updated_at  timestamptz not null default now()
    );
    insert into labels_qr_settings (id) values (1) on conflict do nothing;
  end if;
end $$;
