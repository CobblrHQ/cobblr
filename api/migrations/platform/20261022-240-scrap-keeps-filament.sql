-- A scrapped print keeps the filament it used off the spool (#7890). Scrapping
-- judges the part, not the plastic: the print melted its filament either way.
--
-- digifab's scrap verdict no longer carries grams, and inventory no longer
-- seeds the digifab.print.reversed → inventory:adjust-stock wire. The boot
-- backfill only ADDS default wires, so drop the one existing workspaces hold,
-- as 20260618-067 did for the old task-close wire. Only the wire as seeded:
-- one a person gave a template or arguments of their own stays theirs.
-- Idempotent: a no-op once dropped.

delete from entity_action_bindings
where action_id = 'inventory:adjust-stock'
  and trigger_event = 'digifab.print.reversed'
  and source_module = 'inventory'
  and template is null
  and args is null;
