-- Where a personal document's original went (#5331, the Vault #5242).
--
-- A bill of sale read on the personal path is filed into the Vault of the
-- person who brought it, encrypted, when it is read. Its inbox card does not
-- know the car yet; "It's this one" does, and links the Vault document to it
-- then. This is that document's Vault id, nothing else of it. Null for a
-- session whose original is in Files, or one kept nowhere.
alter table core_scan_batches add column if not exists vault_file_id text;
