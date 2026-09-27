-- Which line of its target a reservation serves.
--
-- A pattern needs two yarns: Main Color from one ball and Contrast A from
-- another. Both reservations point at the same pattern, so without a line
-- nothing could say which ball belongs to which yarn, what each has used so
-- far, or move one of them to a different yarn halfway through without
-- touching the other. `target_line` is the target's own name for the line
-- (for a pattern, the id of its requirement); null means the whole target, as
-- every reservation made before this does.

alter table inventory_allocations add column target_line text;

create index inventory_allocations_target_line
  on inventory_allocations (target_entity_id, target_line)
  where target_line is not null;
