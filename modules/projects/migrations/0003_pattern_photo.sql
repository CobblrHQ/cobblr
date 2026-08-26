-- The photo a design pulled out of its pattern PDF, and the alternatives.
--
-- One row per (design, pattern file): what the extractor found, which image
-- the floor picked, which one is attached now. The candidates live beside it
-- with a small thumbnail each, so the "other images in the pattern" strip
-- renders from here instead of re-reading the PDF on every open, and a
-- pattern with no photograph is answered once, not on every page load.

create table projects_pattern_photos (
  design_id uuid not null,
  pattern_file_id uuid not null,
  extracted integer not null default 0,
  hero_index integer,
  used_index integer,
  photo_file_id uuid,
  attachment_id uuid,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (design_id, pattern_file_id)
);

create table projects_pattern_photo_candidates (
  design_id uuid not null,
  pattern_file_id uuid not null,
  idx integer not null,
  page integer not null,
  width integer not null,
  height integer not null,
  photo boolean not null,
  metrics jsonb not null default '{}'::jsonb,
  thumb bytea not null,
  primary key (design_id, pattern_file_id, idx)
);
