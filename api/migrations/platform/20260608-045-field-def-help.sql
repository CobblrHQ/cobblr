-- Plain-language helper text for a custom field. Bundle field defs can carry a
-- one-line `help` ("the maker's named shade — e.g. 'Peacock Heather'") rendered
-- as muted sub-text under the input on create + detail forms, so jargon fields
-- (colorway, dye lot, …) explain themselves to a novice. Authored by the bundle
-- so the explanation lives with the domain, not hardcoded in the UI.
--
-- Additive + nullable, so it applies cleanly to every existing row (null = no
-- hint, renders nothing).
--
-- manual recovery if this fails partway:
--   ALTER TABLE module_field_defs DROP COLUMN help;
--   DELETE FROM migrations WHERE name = 'platform::20260608-045-field-def-help.sql';

ALTER TABLE module_field_defs
  ADD COLUMN help text;
