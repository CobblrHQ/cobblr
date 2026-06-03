-- Phase 2: wire target field + pairing traversal.
--
-- Q1 from docs/architecture/wires-and-bundles.md:
--   * `target: "self"` (default) — action runs on the source entity.
--     Preserves today's "fire-on-source" behaviour; most wires don't
--     declare target at all and get this for free.
--   * `target: { rel, dir?, kind? }` — action runs on entities
--     discovered by traversing entity_pairings from the source.
--     `rel` is required; `dir` defaults to "in" (incoming pairings);
--     `kind` filters the discovered target kind when one source pairs
--     with multiple kinds.
--
-- Existing rows get `"self"` retroactively — same behaviour they had
-- before this column existed.
--
-- See:
--   docs/architecture/wires-and-bundles.md — Q1 resolution + alternatives
--   docs/product/build-plan.md — Phase 2

alter table entity_action_bindings
  add column target jsonb not null default '"self"'::jsonb;

comment on column entity_action_bindings.target is
  'Q1 wire target. JSON value: string "self" (action runs on source — default), OR object {rel, dir?, kind?} (action runs on entities discovered via entity_pairings). See docs/architecture/wires-and-bundles.md.';
