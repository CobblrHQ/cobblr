-- design-workspace can plan starter records to seed AFTER the schema applies
-- (e.g. one inventory part per hook size the user enumerated). The plan is
-- generated at build time but only executed on apply (install schema → create
-- records), so it rides along on the draft as [{ kind, records:[{...}] }].
alter table core_authoring_drafts add column seed_plan jsonb;
