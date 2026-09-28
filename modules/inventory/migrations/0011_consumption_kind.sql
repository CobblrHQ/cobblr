-- What a ledger line IS, beyond its sign.
--
-- A negative delta used to mean "something was used", and the burn rate reads
-- every one as consumption. A recount is not that: finding two fewer on the
-- shelf than the record said is the record being wrong, not two eaten, and
-- counting it as use teaches the workspace to buy more of the thing. `kind`
-- says so. Null is an ordinary move (use, restock, a wire's adjustment), as
-- every line written before this is; 'correction' is a count set to what is
-- actually there.

alter table inventory_consumption add column kind text;
