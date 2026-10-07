-- How a number or money field adds up in a group's summary (#5079).
--
-- A grouped table totalled every number field, so "Length / ball" summed over
-- two different yarns (167 + 211 = 378) and printed a figure that means
-- nothing. A field now says how it adds up:
--   sum       added across the group (a count, an amount spent). NULL means
--             this, the rule every field had until now.
--   per_unit  a property of ONE item (length per ball, price each): never added
--             as it is; totalled as value x the kind's quantity, and labelled
--             as a total ("Total length (m)").
--   none      never totalled (a reorder threshold).
-- Additive: NULL keeps every existing field as it was.
alter table module_field_defs add column if not exists aggregate text
  check (aggregate is null or aggregate in ('sum', 'per_unit', 'none'));
