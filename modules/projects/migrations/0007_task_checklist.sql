-- A task's checklist: the small steps inside one task ("buy tiles", "mix
-- grout", "seal"), each ticked off on its own, so a task says how far along
-- it is without becoming a project of its own.
--
-- An ordered array of {id, text, done}. Additive with a default, so every
-- task, old and new, reads an empty list.

alter table projects_tasks add column if not exists checklist jsonb not null default '[]'::jsonb;
