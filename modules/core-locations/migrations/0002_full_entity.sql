-- Promote locations to full first-class entities — same shape as
-- inventory parts / assets / machines. HomeBox-parity work: a
-- location should be a place you can OPEN, see its contents,
-- attach photos to ("here's what bin 17 looks like"), tag, write
-- maintenance entries against.
--
-- Tags + files attachment storage is already polymorphic on
-- (source_module, source_type, source_id) — no schema change there;
-- the convention is source_module='core-locations',
-- source_type='location'. This migration just lifts the location
-- record itself into shape.

alter table core_locations_locations
  add column description text,
  add column notes       text,
  add column image_path  text;
