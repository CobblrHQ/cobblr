-- F-13 — per-effect completion policy. The projects "auto-close the linked task"
-- wire moved from digifab.print.completed → digifab.print.confirmed (the
-- bed-clear "good" verdict), because a manager's "completed" only means the
-- gcode finished, not that a good part exists — silently closing the human's
-- task on a failed print is the one effect too costly to get wrong.
--
-- The manifest change re-seeds the new (confirmed) wire on boot via
-- backfillDefaultBindings, but that backfill only ADDS — it never removes the
-- old (completed) binding from existing workspaces. So drop the stale ones here;
-- the backfill installs the confirmed variant. Idempotent: a no-op once dropped.
-- (Filament-deduct and machine-usage wires deliberately STAY on print.completed
-- — those effects are cheap to reverse and fire optimistically; only task-close
-- gates on the human verdict.)

delete from entity_action_bindings
where action_id = 'projects:mark-task-done'
  and trigger_event = 'digifab.print.completed';
