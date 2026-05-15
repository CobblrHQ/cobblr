-- Optional `choices` array on text-type field-defs. Renders as a
-- dropdown in the UI instead of a free-text input. Users can
-- extend the list inline via the "+ add new" affordance, which
-- PATCHes the field-def row to append a value.
--
-- Only meaningful when type='text'. Application validates that.

alter table module_field_defs
  add column if not exists choices jsonb;

-- Sanity check: choices must be an array of strings when set.
-- (We don't enforce this in SQL — the API validates with Zod.)
