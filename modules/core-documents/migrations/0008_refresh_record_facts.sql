-- Re-read each record through its own collection before rematching, so
-- cached base-kind facts cannot hide a VIN conflict or a year warning.
update core_documents_records set status = 'queued', attempts = 0;
