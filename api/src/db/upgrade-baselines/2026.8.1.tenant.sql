insert into inventory_parts (id,name,qty,min_qty,unit) values
 ('10000000-0000-4000-8000-000000000001','Neg',-1,0,'each'),
 ('10000000-0000-4000-8000-000000000002','Fine',12.345,1.5,'g'),
 ('10000000-0000-4000-8000-000000000003','Big',999999999.999,0,'each');
insert into inventory_allocations (part_id,qty,target_module,target_entity_type,target_entity_id) values
 ('10000000-0000-4000-8000-000000000002',2.5,'m','t','1');
insert into inventory_consumption (part_id,delta) values
 ('10000000-0000-4000-8000-000000000002',-1),
 ('10000000-0000-4000-8000-000000000002',-1);
insert into core_maintenance_entries (entity_module,entity_type,entity_id,name,scheduled_at) values
 ('m','t','20000000-0000-4000-8000-000000000001','midnight','2026-10-15T00:00:00Z'),
 ('m','t','20000000-0000-4000-8000-000000000001','noon','2026-10-15T12:00:00Z');
insert into core_ai_capability_defaults (capability,provider_id,model) values
 ('chat','anthropic','claude-haiku-4-5'),('identify-image','anthropic','claude-sonnet-4-5'),('extract-text','openai','gpt-x');
insert into purchases_orders (id,status) values ('30000000-0000-4000-8000-000000000001','ordered');
insert into purchases_order_items (order_id,qty,part_id) values
 ('30000000-0000-4000-8000-000000000001',2,'10000000-0000-4000-8000-000000000002'),
 ('30000000-0000-4000-8000-000000000001',1,null);
insert into sales_orders (id,status) values ('40000000-0000-4000-8000-000000000001','shipped'),('40000000-0000-4000-8000-000000000002','draft');
insert into sales_order_items (order_id,qty) values
 ('40000000-0000-4000-8000-000000000001',3),('40000000-0000-4000-8000-000000000002',4);
