-- What each library item is called in outside catalogues (a ROM's IGDB id),
-- remembered as items are read, so a record holding that id finds its item
-- whenever the record is matched. Until now an outside id only ever matched
-- during a library's catch-up, against the records that existed at that
-- moment: a cartridge given its IGDB id after the library was connected
-- never found its ROM, because a search by its name cannot.
--
-- Additive. The connections are marked as not yet caught up, once, so the
-- next round reads each library's collection again and fills this in for
-- libraries connected before it existed (the catch-up is bounded per round).

create table if not exists core_documents_item_ids (
  connection_id text not null,
  catalogue     text not null,
  outside_id    text not null,
  ref           text not null,
  seen_at       timestamptz not null default now(),
  primary key (connection_id, catalogue, outside_id, ref)
);

create index if not exists core_documents_item_ids_lookup
  on core_documents_item_ids (connection_id, outside_id);

update core_documents_connections set caught_up_to = null, caught_up_at = null;
