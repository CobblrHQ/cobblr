-- Slice 4 (demo/debug workspaces): per-workspace entitlement overrides. A demo often
-- needs exactly what the trial tier locks (uploads, AI, extra members). demo_unlocks is
-- an allow-list of feature keys / module names the trial guard + module-enable gate
-- consult for THIS workspace, so a demo can use them while the tier stays locked for real
-- trials. Empty '{}' everywhere else — additive, no behaviour change off a demo.
alter table orgs add column if not exists demo_unlocks text[] not null default '{}';
