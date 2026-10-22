-- When this instance first ran a build carrying each registered heal pass.
--
-- A heal takes only rows made before its fix, so it never rewrites a row fixed
-- code made (#7282). It dated "before its fix" by the merge, which assumed no
-- box ran old code after the merge. Every box on 2026.8.1 or an older nightly
-- does, until it upgrades: the release check's 2026.8.1 → nightly-2026-10-05 →
-- candidate run kept a doubled Files (run 55860), and three heals miss every
-- row a 2026.8.1 box wrote after their merge. A heal's visit now takes rows
-- made before the later of its merge and this instance's first run of it.
--
-- Additive: one new table. No row means the pass has not run here yet; the
-- first boot that registers it writes one (heal-shim-log.ts, healArrival).
create table if not exists heal_pass_arrivals (
  name        text primary key,
  arrived_at  timestamptz not null
);
