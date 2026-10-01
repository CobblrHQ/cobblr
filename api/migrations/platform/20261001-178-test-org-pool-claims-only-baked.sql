-- TEST-ONLY table (see 20260705-077-test-org-pool.sql): a row is claimable
-- only when the BAKE says so. The default was 'available', so a test that put
-- its own fresh workspace in the pool (to stand for a pooled one) made it
-- claimable by default, and another test was handed it while the first
-- test's teardown deleted it: `409 workspace_deleting` (run 35775). The bake
-- now writes 'available' itself (api/src/db/test-org-pool.ts); a row written
-- without a status is 'unbaked', which no checkout ever claims. Rows already
-- baked keep their status. A default change: additive.
alter table test_org_pool alter column status set default 'unbaked';
