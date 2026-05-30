-- Vocabulary generalization: the columns were print/farm-shaped, but
-- digifab spans laser/CNC/textile. Rename to neutral device/remote terms.
-- The original CREATE migrations (0002/0003) stay immutable; this renames.
--   farm_*  → remote_* (an id/name from the external manager)
--   target_printer → target_device (which device to send to)
alter table digifab_jobs rename column farm_job_id to remote_job_id;
alter table digifab_jobs rename column farm_file_id to remote_file_id;
alter table digifab_jobs rename column target_printer to target_device;
alter table digifab_printer_links rename column farm_printer_id to remote_device_id;
alter table digifab_printer_links rename column farm_printer_name to remote_device_name;
