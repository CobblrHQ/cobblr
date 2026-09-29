-- Who drew a part down (#3801). A club's closet shares one stock among its
-- members, and "who took the last cable" had no answer: the ledger said what
-- and how much, never who. Null for rows written before this, and for a
-- change nobody made by hand (a wire, a sync, a job).
alter table inventory_consumption add column if not exists by_user uuid;
