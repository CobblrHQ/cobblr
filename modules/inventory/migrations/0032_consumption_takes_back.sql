-- A ledger line that takes back an earlier move (a station's Undo) is filed
-- as a correction, but it is not a count of what is there: an older Undo is
-- refused over a count set since its move, and must not mistake another
-- Undo for one (#8591).
alter table inventory_consumption add column if not exists takes_back boolean not null default false;
