-- labels 0.7.0 - user-defined label sizes (free-form media + label).
--
-- Until now every label size was a hardcoded preset (src/label-sizes.ts). A
-- workspace can now define its own: a media sheet (w x h in inches) and a label
-- (w x h), from which the col x row grid is DERIVED (deriveGrid), never stored.
-- So "a 1.5 x 3 sheet holding two 1.5in squares" is two measurements, not a
-- preset someone adds in code. See
-- docs/design-decisions/label-media-and-accumulation.md (slice 1b).
--
-- Tenant-local: no org_id, the tenant DB is the org. Additive; nothing renames.

create extension if not exists "pgcrypto";

create table if not exists labels_custom_sizes (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  -- The loaded media, in inches (the unit the PDF/label registry already uses).
  media_w              numeric(8,4) not null check (media_w > 0),
  media_h              numeric(8,4) not null check (media_h > 0),
  -- The individual label, in inches.
  label_w              numeric(8,4) not null check (label_w > 0),
  label_h              numeric(8,4) not null check (label_h > 0),
  -- Margins around the sheet and gaps between labels (inches). The grid is
  -- derived from these at read time; nothing here stores cols/rows.
  margin_t             numeric(8,4) not null default 0 check (margin_t >= 0),
  margin_l             numeric(8,4) not null default 0 check (margin_l >= 0),
  col_gap              numeric(8,4) not null default 0 check (col_gap >= 0),
  row_gap              numeric(8,4) not null default 0 check (row_gap >= 0),
  created_by_user_id   text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
