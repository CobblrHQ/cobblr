-- The photo an order email printed beside each line, with that row's words
-- ([{text, url}]), kept on the receipt's session so a re-read gives every
-- line its own picture again (#5350). Null for a session that did not come
-- from an email with line photos. Nullable, additive.
alter table core_scan_batches
  add column if not exists line_images jsonb;
