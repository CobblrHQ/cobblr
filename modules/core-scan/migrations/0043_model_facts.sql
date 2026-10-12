-- What the workspace has learned about each model (#6013).
--
-- A fact about a model (a Bambu Lab P1P's 250 x 250 bed) is true of every
-- unit of it, so it is kept once, keyed by the table and the model's folded
-- name, and every inbox row of that model fills its empty field from here
-- (services/model-facts.ts). Only fields whose scope is "model" are kept;
-- a unit's seller, serial or price never is. `source` says who taught it:
-- a person's value replaces any other, every other source keeps the first.
create table if not exists core_scan_model_facts (
  kind text not null,
  model_key text not null,
  field text not null,
  value jsonb not null,
  source text not null,
  from_item_id uuid,
  updated_at timestamptz not null default now(),
  primary key (kind, model_key, field)
);
