-- Final vocabulary cleanup: the links table mapped a Cobblr machine to an
-- external "printer"; generalize to "device" (laser/CNC/textile too). The
-- CREATE (0003) + column renames (0006) stay immutable; this renames the
-- table. Indexes + constraints follow the table automatically.
alter table digifab_printer_links rename to digifab_device_links;
