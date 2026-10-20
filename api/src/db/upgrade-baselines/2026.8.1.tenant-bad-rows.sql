-- Rows 2026.8.1 wrote that a later fix stopped writing; the boot heals repair them (#7679).
-- A receipt confirmed as a purchase order: every item twice, once with no part (made at parse),
-- once with the part the confirm added.
insert into purchases_orders (id,status) values ('30000000-0000-4000-8000-0000000000d1','ordered');
insert into purchases_order_items (order_id,description,qty,part_id,created_at) values
 ('30000000-0000-4000-8000-0000000000d1','Croissant',2,null,'2026-08-20T10:00:00Z'),
 ('30000000-0000-4000-8000-0000000000d1','Croissant',2,'10000000-0000-4000-8000-000000000002','2026-08-20T10:00:00Z'),
 ('30000000-0000-4000-8000-0000000000d1','Baby carrots',1,null,'2026-08-20T10:00:00Z');
-- Catalog collections: Books holds phantom quantities of one, Tools a real count.
insert into inventory_parts (id,name,qty,unit,instance) values
 ('10000000-0000-4000-8000-0000000000b1','Dune',1,'each','books'),
 ('10000000-0000-4000-8000-0000000000b2','Emma',1,'each','books'),
 ('10000000-0000-4000-8000-0000000000c1','Hammer',5,'each','tools');
-- Filament: a spool a scan filed in the types table (three scanned), and a spool with no type.
insert into inventory_parts (id,name,qty,unit,instance,metadata) values
 ('10000000-0000-4000-8000-0000000000e1','Prusament PLA Galaxy Black',3,'each','filament-types','{"scan_source":"photo","color":"Galaxy Black"}'),
 ('10000000-0000-4000-8000-0000000000e2','Polymaker PLA Red 1.75mm',1,'kg','filament','{"color":"Red"}');
