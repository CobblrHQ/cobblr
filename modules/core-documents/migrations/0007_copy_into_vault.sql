-- A personal document brought from a library is kept in the person's Vault
-- (#5871), never in shared Files: its own column, so "Open the copy" (a
-- shared file, /files/<id>) never points at a Vault document.

alter table core_documents_linked
  add column copied_vault_file_id text;
