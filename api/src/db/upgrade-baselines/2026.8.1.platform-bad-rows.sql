-- Rows 2026.8.1 wrote that a later fix stopped writing, which the boot heals repair on the first boot of an
-- install that jumps from 2026.8.1 (#7679). Planted after 2026.8.1.platform.sql, before any later migration.
insert into orgs (id,name,slug,db_name) values
 ('00000000-0000-4000-8000-0000000000a3','Three','three','db_three');
-- An AI key attached to a workspace, approved by its own owner and never switched on.
insert into user_credentials (id,user_id,provider_id,credentials_encrypted) values
 ('00000000-0000-4000-8000-0000000000c3','00000000-0000-4000-8000-0000000000b1','gemini','x');
insert into user_credential_orgs (credential_id,org_id,mode,approved_at,approved_by,active) values
 ('00000000-0000-4000-8000-0000000000c3','00000000-0000-4000-8000-0000000000a3','workspace-default','2026-08-20T10:00:00Z','00000000-0000-4000-8000-0000000000b1',false);
-- A list renamed through the assistant: the rename was written under the bare list name.
insert into workspace_module_instances (org_id,module_name,instance_name,display_name) values
 ('00000000-0000-4000-8000-0000000000a1','assets','computers','Computers');
insert into entity_kind_overrides (org_id,target_kind,target_id,display_label,display_label_plural) values
 ('00000000-0000-4000-8000-0000000000a1','instance','computers','Rigs','Rigs');
-- An order email archived with the store's sign-in link in plain text.
insert into inbound_emails (to_addr,from_email,subject,text_body,html_body,org_id,user_id,handler,received_at) values
 ('receipts+x@example.org','orders@shop.example.org','Order #7731 confirmed',
  E'Thank you!\nView your order: https://shop.example.org/_t/c/v3/OldKeyExample9Q==\nOrder #7731',
  '<a href="https://shop.example.org/_t/c/v3/OldKeyExample9Q==">View your order</a><p>Order #7731</p>',
  '00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000b1','receipt','2026-08-20T10:00:00Z');
-- A bundle (Groceries) wire installed at both scopes: one event fired two actions.
insert into bundles (id,org_id,external_id,name,version,manifest) values
 ('00000000-0000-4000-8000-0000000000d1','00000000-0000-4000-8000-0000000000a1','groceries','Groceries','1.0.0','{}');
insert into entity_action_bindings (org_id,source_kind,action_id,trigger_type,trigger_event,args,bundle_id,created_at) values
 ('00000000-0000-4000-8000-0000000000a1','inventory:part','inventory:adjust-stock','event','lists.item.checked','{"delta":1}','00000000-0000-4000-8000-0000000000d1','2026-08-20T10:00:00Z'),
 ('00000000-0000-4000-8000-0000000000a1','groceries:item','inventory:adjust-stock','event','lists.item.checked','{"delta":1}','00000000-0000-4000-8000-0000000000d1','2026-08-20T10:00:00Z');
-- Two catalog collections the camera sheet latched to the stock face: Books holds only phantom ones (the sheet
-- sent a quantity of 1), Tools holds a real count (its latch is right and must stay).
insert into entity_kind_overrides (org_id,target_kind,target_id,config) values
 ('00000000-0000-4000-8000-0000000000a1','instance','inventory:books','{"stock_latched": true}'),
 ('00000000-0000-4000-8000-0000000000a1','instance','inventory:tools','{"stock_latched": true}');
-- A workspace the old signup left with no database, whose owner can finish it; one nobody owns; and one made
-- a moment ago, which a signup may still be finishing.
insert into orgs (id,name,slug,db_name,created_at) values
 ('00000000-0000-4000-8000-0000000000a4','Four','four','db_four','2026-08-20T10:00:00Z'),
 ('00000000-0000-4000-8000-0000000000a5','Five','five','db_five','2026-08-20T10:00:00Z'),
 ('00000000-0000-4000-8000-0000000000a6','Six','six','db_six',now());
insert into org_memberships (user_id,org_id,role) values
 ('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a4','owner'),
 ('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000a6','owner');
