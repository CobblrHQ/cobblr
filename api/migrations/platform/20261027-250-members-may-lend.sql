-- A member may lend and return things (a makerspace's checkout) in a workspace
-- born after this; existing workspaces stay as they were, and their owners are
-- asked once (members_lend_asked) whether to allow it. An update never opts a
-- workspace in.
alter table orgs add column members_may_lend boolean not null default false;
alter table orgs alter column members_may_lend set default true;
alter table orgs add column members_lend_asked boolean not null default false;
alter table orgs alter column members_lend_asked set default true;
