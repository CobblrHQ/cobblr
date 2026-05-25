-- B2 from 2026-05-25-audit.md: bundle install partial-state visibility.
--
-- Bundle install touches both cobblr_meta (bundles, wires, field
-- defs) and the tenant DB (catalogs, saved views). The two DBs
-- can't be in one transaction. A failure mid-flight leaves the
-- meta-side rows but partially-applied tenant rows. We catch +
-- log errors but the bundle row stays, with no indication to the
-- workspace admin that the install was incomplete.
--
-- This column tracks: 'active' (everything applied), 'partial'
-- (one or more tenant-side steps failed during install), 'pending'
-- (install in flight). Surfaced in the bundles list + the
-- super-admin modules tab; admin can re-install to recover.

alter table bundles
  add column if not exists install_status text not null default 'active'
    check (install_status in ('active', 'partial', 'pending'));

alter table bundles
  add column if not exists install_warnings jsonb not null default '[]'::jsonb;
