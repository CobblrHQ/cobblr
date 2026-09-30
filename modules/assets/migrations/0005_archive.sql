-- An asset you no longer have but want the record of (sold, given away,
-- lost) is put away, not deleted: its history, cost and links stay, and it
-- leaves the register, search and Needs you until restored. Additive and
-- nullable: nothing is archived until someone archives it.

alter table assets_assets add column if not exists archived_at timestamptz default null;
create index if not exists assets_assets_archived_idx on assets_assets(archived_at) where archived_at is not null;
