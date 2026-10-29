-- Every write that puts a place inside another takes the workspace's tree
-- lock, whichever door it came through: the form, the assistant, an import, a
-- layout's Apply, a bundle. A delete holds that lock from reading what is
-- inside a place to deleting its row, so a shelf made or moved in there
-- meanwhile either lands first and goes into the delete's undo, or waits and
-- finds the place gone. Before this, the cascade took such a shelf with the
-- room, its things went on naming a place no longer there, and Undo brought
-- the room back without it (#4115). The key is the one movePlace takes
-- (src/api/place-move.ts), and a transaction already holding it takes it
-- again freely. Additive: a function and a trigger, no data changes.
--
-- manual recovery if this fails partway:
--   DROP TRIGGER IF EXISTS core_locations_tree_lock ON core_locations_locations;
--   DROP FUNCTION IF EXISTS core_locations_take_tree_lock();
create or replace function core_locations_take_tree_lock() returns trigger
language plpgsql as $$
begin
  if NEW.parent_id is not null then
    perform pg_advisory_xact_lock(hashtext('core_locations_locations.parent_id'));
  end if;
  return NEW;
end;
$$;

drop trigger if exists core_locations_tree_lock on core_locations_locations;
create trigger core_locations_tree_lock
  before insert or update of parent_id on core_locations_locations
  for each row execute function core_locations_take_tree_lock();
