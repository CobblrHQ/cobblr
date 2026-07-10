-- A field def can declare the UNIT its numeric value is measured in
-- ("mm", "g", "in", ...). Free text BY DESIGN, matching the units
-- vocabulary's philosophy (modules/core-units/src/units-catalog.ts): the
-- catalog is a display + input aid, resolveUnit() interprets the string at
-- render/consume time (symbol -> code -> name, case-insensitive), and an
-- unmatched string still renders as-is. No FK, no enum: workspace custom
-- units and future catalog growth need no schema change.
--
-- Why declare it at all: a declared unit gives a field MACHINE-READABLE
-- physical semantics without keyword-matching its name -- a field whose
-- unit resolves to the catalog's `length` category IS a length, whatever
-- the field is called. First consumer: Guided Organize's size awareness
-- (docs/product/guided-organize.md sect. 3.4). Display-wise, list rows +
-- detail pages suffix the value ("12 mm"), honoring the workspace's
-- symbol/name display preference.
alter table module_field_defs
  add column if not exists unit text
    check (unit is null or char_length(unit) <= 40);
