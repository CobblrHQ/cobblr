-- Whether a field remembers what a person types as a new choice
-- (@cobblr/platform-contract/field-choices). NULL is the default rule (a
-- person's own field with choices learns; a bundle's field declares it).
-- Additive.
alter table module_field_defs add column if not exists learns boolean;

-- The Provenance preset's "Acquired from" now starts the picker with the
-- common places and is an open list (field-presets.ts). Workspaces that turned
-- the preset on before this get the same: only a field still exactly as the
-- preset made it (no choices, nobody has said whether it learns), so a list
-- someone curated is never touched. A value already stored stays as it is.
update module_field_defs
   set choices = '["Amazon","eBay","Facebook Marketplace","Craigslist","Store","Gift","Thrift","Made it","Hand-me-down"]'::jsonb,
       learns = true
 where name = 'acquired_from'
   and field_role = 'acquired-from'
   and type = 'text'
   and bundle_id is null
   and source_module is null
   and choices is null
   and learns is null;
