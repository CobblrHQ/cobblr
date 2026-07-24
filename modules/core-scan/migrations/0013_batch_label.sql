-- A scan session (core_scan_batches) can carry a human title + origin so the
-- inbox header can read "Receipt · Home Depot" / "Receipt · emailed Jul 24" for
-- an emailed or uploaded receipt, instead of a bare timestamp. Additive +
-- nullable: existing batches (plain scan sessions) stay label-less and render by
-- time exactly as before.

alter table core_scan_batches add column if not exists label  text;
alter table core_scan_batches add column if not exists origin text;
