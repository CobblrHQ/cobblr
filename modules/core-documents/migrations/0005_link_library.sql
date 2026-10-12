-- Which library a link was made through, by program and address, so a link
-- whose connection is removed can name it to Reconnect and move to the same
-- library connected again (#5876). Older links have neither and fall back to
-- the item's own open address.
alter table core_documents_linked
  add column library_provider text,
  add column library_address text;
