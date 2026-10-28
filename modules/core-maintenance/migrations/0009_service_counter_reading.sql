alter table core_maintenance_entries add column counter_reading numeric check (counter_reading >= 0);
